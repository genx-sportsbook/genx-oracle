"""Standalone FastAPI service — proxies TxLINE data to browser clients via SSE."""

import asyncio
import json
import logging
import time
from contextlib import aclosing, asynccontextmanager
from pathlib import Path
from typing import Optional

import click
import httpx
import uvicorn
from fastapi import FastAPI, Query, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from httpx_sse import SSEError
from sse_starlette.sse import EventSourceResponse

from txline.auth import get_guest_jwt, load_credentials
from txline.exceptions import TxLineStreamError
from txline.models import Heartbeat, TokenCredentials
from txline.rest.fixtures import get_fixtures_window
from txline.streams.odds import stream_odds
from txline.streams.scores import stream_scores

logger = logging.getLogger(__name__)
DEFAULT_CREDS = Path(".txline-credentials.json")

# get_fixtures_window fetches two full days' worth of the global fixture
# catalog (~34MB each) to cover the yesterday/today bucket boundary — see
# its docstring. Measured end to end that's ~5s on the wire plus ~2s of
# Pydantic validation, peaking around 600MB RSS, for ~116k fixtures. Far
# too expensive to pay per request, and schedule data (names, kickoff
# times, competitions) barely changes minute to minute.
FIXTURES_CACHE_TTL = 300  # seconds — how stale a cached body may get

# Refresh ahead of the TTL so a browser request never lands on an expired
# cache and has to block on the upstream fetch itself.
FIXTURES_REFRESH_INTERVAL = 240  # seconds

# The dashboard only reads these five fields off each fixture (see
# resolveNameFromCache() in static/app.js); the other eight are dead weight.
# Trimming halves the response — 34MB -> 16MB — and, more importantly, cuts
# the serialization from ~3.2s of event-loop-blocking work down to ~0.3s.
FIXTURE_FIELDS = ("FixtureId", "Participant1", "Participant2", "Competition", "StartTime")


JWT_REFRESH_COOLDOWN = 30  # seconds


class UpstreamCredentials:
    """Share JWT recovery across the fixture cache and both SSE feeds."""

    def __init__(self, creds: TokenCredentials, path: Path | None):
        self.current = creds
        self._file_creds = creds
        self._path = path
        self._lock = asyncio.Lock()
        self._next_refresh = 0.0

    async def recover(self, rejected: TokenCredentials) -> bool:
        async with self._lock:
            if self._path is not None:
                try:
                    replacement = load_credentials(self._path)
                except (OSError, ValueError, TypeError):
                    logger.warning("Could not load updated TxLINE credentials")
                else:
                    if replacement is not None and replacement != self._file_creds:
                        self._file_creds = self.current = replacement
                        self._next_refresh = 0.0
            if self.current is not rejected:
                return True
            if time.monotonic() < self._next_refresh:
                return False

            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    jwt = await get_guest_jwt(client)
                if not isinstance(jwt, str) or not jwt.strip():
                    raise ValueError("Missing guest JWT")
            except (httpx.HTTPError, ValueError, KeyError, TypeError):
                logger.warning("Could not renew TxLINE guest JWT")
                return False
            finally:
                self._next_refresh = time.monotonic() + JWT_REFRESH_COOLDOWN

            self.current = rejected.model_copy(update={"jwt": jwt})
            logger.info("Renewed TxLINE guest JWT")
            return True


class FixturesCache:
    """Serialized-bytes cache for the fixture snapshot, refreshed off-request.

    Holds the finished JSON body rather than the Pydantic models: FastAPI
    re-encoding ~116k models cost ~3.2s of synchronous CPU on *every* call,
    which on a single-worker uvicorn also stalls the live SSE streams
    sharing that event loop. Encoding once per refresh removes that
    entirely — a cache hit is now just handing back a bytes object.
    """

    def __init__(self, auth: UpstreamCredentials):
        self._auth = auth
        self._body: Optional[bytes] = None
        self._fetched_at = 0.0
        self._client: Optional[httpx.AsyncClient] = None
        # Single-flight: without it, concurrent cold requests would each
        # start their own 68MB fetch and 600MB-peak parse.
        self._lock = asyncio.Lock()

    def _http(self) -> httpx.AsyncClient:
        """One client for the process, so refreshes reuse the upstream
        connection instead of redoing TLS every time."""
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0))
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def is_stale(self) -> bool:
        return self._body is None or time.monotonic() - self._fetched_at > FIXTURES_CACHE_TTL

    async def _fetch(self) -> None:
        """Fetch and re-encode. Callers must hold self._lock."""
        creds = self._auth.current
        try:
            fixtures = await get_fixtures_window(self._http(), creds.jwt, creds.api_token)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 401 or not await self._auth.recover(creds):
                raise
            creds = self._auth.current
            fixtures = await get_fixtures_window(self._http(), creds.jwt, creds.api_token)
        self._body = json.dumps(
            [{k: getattr(f, k) for k in FIXTURE_FIELDS} for f in fixtures],
            separators=(",", ":"),
        ).encode()
        self._fetched_at = time.monotonic()
        logger.info("fixtures cache refreshed: %d fixtures, %d bytes",
                    len(fixtures), len(self._body))

    async def refresh(self) -> None:
        async with self._lock:
            await self._fetch()

    async def body(self) -> Optional[bytes]:
        """Cached body, fetching on demand only if nothing has been cached yet.

        A merely *stale* body is returned as-is and left for the background
        refresher to replace — serving schedule data a few minutes old beats
        making a page load wait ~7s for a fresh copy.
        """
        if self._body is None:
            async with self._lock:
                # Re-checked inside the lock: callers that queued behind an
                # in-flight fetch take its result rather than each starting
                # another one. Checking only before the lock serializes the
                # herd without actually deduplicating it.
                if self._body is None:
                    try:
                        await self._fetch()
                    except Exception:
                        logger.exception(
                            "fixtures fetch failed with no cached copy to fall back on"
                        )
        return self._body


def create_app(creds: TokenCredentials, credentials_path: Path | None = None) -> FastAPI:
    auth = UpstreamCredentials(creds, credentials_path)
    cache = FixturesCache(auth)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async def refresher():
            while True:
                try:
                    await cache.refresh()
                except Exception:
                    # Keep serving the last good copy; an expired JWT or a
                    # blip upstream must not take the pod down with it.
                    logger.exception("fixtures refresh failed; serving previous copy")
                await asyncio.sleep(FIXTURES_REFRESH_INTERVAL)

        # Deliberately not awaited: startup must not block on a ~7s upstream
        # fetch, or the container is unreachable (and failing its probes) for
        # that whole window on every rollout.
        task = asyncio.create_task(refresher())
        try:
            yield
        finally:
            task.cancel()
            await cache.aclose()

    app = FastAPI(title="TxLINE Proxy", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def no_cache(request, call_next):
        # StaticFiles only sends Last-Modified/ETag, no Cache-Control — browsers
        # then apply their own heuristic freshness, which can serve a stale
        # cached copy of app.js/style.css after an edit until a hard refresh.
        # This is actively edited static UI, not a versioned release asset, so
        # force revalidation every time instead of relying on browser defaults.
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/healthz")
    async def healthz():
        """Liveness/readiness target — process-local, no upstream calls.

        Kubernetes probes used to point at /fixtures, which meant every probe
        could trigger (and then time out on) a multi-second upstream fetch.
        """
        return {"status": "ok", "fixturesCached": not cache.is_stale}

    @app.get("/fixtures")
    async def fixtures_endpoint():
        body = await cache.body()
        if body is None:
            return Response(
                content=b'{"detail":"fixture snapshot unavailable"}',
                media_type="application/json",
                status_code=503,
            )
        return Response(content=body, media_type="application/json")

    async def stream_events(stream, feed: str, fixture_id: int | None):
        for attempt in range(2):
            creds = auth.current
            try:
                events = stream(creds.jwt, creds.api_token, fixture_id=fixture_id)
                async with aclosing(events):
                    async for event in events:
                        if isinstance(event, Heartbeat):
                            yield {"event": "heartbeat", "data": json.dumps({"Ts": event.Ts})}
                        else:
                            yield {"event": feed, "data": event.model_dump_json()}
                return
            except TxLineStreamError as exc:
                if exc.status_code == 401 and attempt == 0 and await auth.recover(creds):
                    continue
                status = (
                    "authentication failed" if exc.status_code in (401, 403) else "feed unavailable"
                )
                logger.warning("TxLINE %s stream rejected with status %s", feed, exc.status_code)
            except (httpx.HTTPError, SSEError):
                status = "feed unavailable"
                logger.warning("TxLINE %s stream connection failed", feed)
            yield {"event": "feed_status", "data": status, "retry": 5000}
            return

    @app.get("/odds/stream")
    async def odds_stream(fixture_id: Optional[int] = Query(default=None, alias="fixtureId")):
        return EventSourceResponse(stream_events(stream_odds, "odds", fixture_id))

    @app.get("/scores/stream")
    async def scores_stream(fixture_id: Optional[int] = Query(default=None, alias="fixtureId")):
        return EventSourceResponse(stream_events(stream_scores, "scores", fixture_id))

    app.mount(
        "/",
        StaticFiles(directory=Path(__file__).parent / "static", html=True),
        name="static",
    )

    return app


@click.command()
@click.option("--credentials", default=str(DEFAULT_CREDS), show_default=True)
@click.option("--host", default="0.0.0.0", show_default=True)
@click.option("--port", default=8000, show_default=True)
def cli(credentials: str, host: str, port: int) -> None:
    """Run the TxLINE SSE proxy server."""
    logging.basicConfig(level=logging.INFO)
    creds = load_credentials(Path(credentials))
    if creds is None:
        raise click.ClickException(
            f"No credentials at {credentials}. Run `txline-subscribe` first."
        )
    uvicorn.run(create_app(creds, Path(credentials)), host=host, port=port)
