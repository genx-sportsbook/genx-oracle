"""Collect the TxLINE fixture snapshot and live feeds into SQLite."""

import asyncio
import json
import logging
import time
from contextlib import aclosing
from pathlib import Path

import click
import httpx
from httpx_sse import SSEError

from txline.auth import get_guest_jwt, load_credentials
from txline.exceptions import TxLineStreamError
from txline.models import Heartbeat, OddsUpdate, TokenCredentials
from txline.rest.fixtures import get_fixtures_window
from txline.rest.odds import get_odds_history
from txline.store import DEFAULT_DATABASE, ENGLISH_PREMIER_LEAGUE_ID, FeedStore
from txline.streams.odds import stream_odds
from txline.streams.scores import stream_scores

logger = logging.getLogger(__name__)
DEFAULT_CREDS = Path(".txline-credentials.json")
FIXTURES_DAYS_AHEAD = 3
HISTORY_LOOKBACK_MS = 6 * 60 * 60 * 1000
FIXTURES_REFRESH_INTERVAL = 240
RECONNECT_DELAY = 5
FEED_STATUS_INTERVAL = 10
JWT_REFRESH_COOLDOWN = 30


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


class Ingester:
    def __init__(self, store: FeedStore, auth: UpstreamCredentials):
        self.store = store
        self.auth = auth
        self.fixture_ids: frozenset[int] = frozenset()

    async def refresh_fixtures(self, client: httpx.AsyncClient) -> None:
        async def fetch(creds: TokenCredentials):
            return await get_fixtures_window(
                client, creds.jwt, creds.api_token,
                competition_id=ENGLISH_PREMIER_LEAGUE_ID, days_after=FIXTURES_DAYS_AHEAD,
            )

        creds = self.auth.current
        try:
            fixtures = await fetch(creds)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 401 or not await self.auth.recover(creds):
                raise
            fixtures = await fetch(self.auth.current)
        self.fixture_ids = await asyncio.to_thread(self.store.replace_fixtures, fixtures)
        logger.info("Refreshed %d fixtures", len(self.fixture_ids))

    async def _refresh_loop(self, client: httpx.AsyncClient, ready: asyncio.Event) -> None:
        while True:
            try:
                await self.refresh_fixtures(client)
            except (httpx.HTTPError, ValueError, TypeError):
                logger.warning("Fixture refresh failed; retaining the stored snapshot")
                await asyncio.to_thread(self.store.trim_history)
            else:
                ready.set()
            await asyncio.sleep(FIXTURES_REFRESH_INTERVAL if ready.is_set() else RECONNECT_DELAY)

    async def backfill_odds(self, client: httpx.AsyncClient, fixture_id: int) -> int | None:
        creds = self.auth.current
        try:
            events = await get_odds_history(client, creds.jwt, creds.api_token, fixture_id)
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code != 401 or not await self.auth.recover(creds):
                raise
            creds = self.auth.current
            events = await get_odds_history(client, creds.jwt, creds.api_token, fixture_id)
        if not events:
            return None
        return await asyncio.to_thread(self.store.append_odds_history, fixture_id, events)

    async def _backfill_loop(self, client: httpx.AsyncClient, ready: asyncio.Event) -> None:
        completed: set[int] = set()
        await ready.wait()
        while True:
            snapshot = await asyncio.to_thread(self.store.snapshot)
            if snapshot is not None:
                now = int(time.time() * 1000)
                end = now + FIXTURES_DAYS_AHEAD * 86_400_000
                fixtures = json.loads(snapshot[1])
                eligible = sorted(
                    (f for f in fixtures if now - HISTORY_LOOKBACK_MS <= f["StartTime"] < end),
                    key=lambda f: abs(f["StartTime"] - now),
                )
                completed.intersection_update(f["FixtureId"] for f in eligible)
                for fixture in eligible:
                    fid = fixture["FixtureId"]
                    if fid in completed:
                        continue
                    try:
                        inserted = await self.backfill_odds(client, fid)
                    except (httpx.HTTPError, ValueError):
                        logger.warning("Odds backfill failed for fixture %d; will retry", fid)
                    else:
                        if inserted:
                            logger.info("Backfilled %d odds updates for fixture %d", inserted, fid)
                        if inserted is not None:
                            completed.add(fid)
            await asyncio.sleep(FIXTURES_REFRESH_INTERVAL)

    async def read_upstream(self, feed: str, stream) -> None:
        creds = self.auth.current
        for attempt in range(2):
            status = "feed unavailable"
            try:
                next_status = 0.0
                async with aclosing(stream(creds.jwt, creds.api_token)) as events:
                    async for event in events:
                        now = time.monotonic()
                        if now >= next_status:
                            await asyncio.to_thread(self.store.set_feed_status, feed, "live")
                            next_status = now + FEED_STATUS_INTERVAL
                        if isinstance(event, Heartbeat):
                            continue
                        fid = event.FixtureId if isinstance(event, OddsUpdate) else event.fixtureId
                        if fid in self.fixture_ids:
                            await asyncio.to_thread(self.store.append, event)
            except TxLineStreamError as exc:
                if exc.status_code == 401 and attempt == 0 and await self.auth.recover(creds):
                    creds = self.auth.current
                    continue
                if exc.status_code in (401, 403):
                    status = "authentication failed"
                logger.warning("TxLINE %s stream rejected with status %s", feed, exc.status_code)
            except (httpx.HTTPError, SSEError):
                logger.warning("TxLINE %s stream disconnected", feed)
            await asyncio.to_thread(self.store.set_feed_status, feed, status)
            return

    async def _feed_loop(self, feed: str, stream, ready: asyncio.Event) -> None:
        await asyncio.to_thread(self.store.set_feed_status, feed, "connecting")
        await ready.wait()
        while True:
            await self.read_upstream(feed, stream)
            await asyncio.sleep(RECONNECT_DELAY)

    async def run(self) -> None:
        await asyncio.to_thread(self.store.initialize)
        self.fixture_ids = await asyncio.to_thread(self.store.fixture_ids)
        ready = asyncio.Event()
        if await asyncio.to_thread(self.store.snapshot) is not None:
            ready.set()
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
            async with asyncio.TaskGroup() as tasks:
                tasks.create_task(self._refresh_loop(client, ready))
                tasks.create_task(self._backfill_loop(client, ready))
                tasks.create_task(self._feed_loop("odds", stream_odds, ready))
                tasks.create_task(self._feed_loop("scores", stream_scores, ready))


@click.command()
@click.option("--credentials", default=DEFAULT_CREDS, type=click.Path(path_type=Path),
              show_default=True)
@click.option("--database", default=DEFAULT_DATABASE, type=click.Path(path_type=Path),
              envvar="TXLINE_DATABASE", show_default=True)
def cli(credentials: Path, database: Path) -> None:
    """Ingest the TxLINE feeds into the dashboard database."""
    logging.basicConfig(level=logging.INFO)
    creds = load_credentials(credentials)
    if creds is None:
        raise click.ClickException(
            f"No credentials at {credentials}. Run `txline-subscribe` first."
        )
    try:
        asyncio.run(Ingester(FeedStore(database), UpstreamCredentials(creds, credentials)).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cli()
