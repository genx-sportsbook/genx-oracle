"""Standalone FastAPI service — proxies TxLINE data to browser clients via SSE."""

import json
import logging
from pathlib import Path
from typing import Optional

import click
import httpx
import uvicorn
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse

from txline.auth import load_credentials
from txline.models import Heartbeat, TokenCredentials
from txline.rest.fixtures import get_fixtures
from txline.streams.odds import stream_odds
from txline.streams.scores import stream_scores

logger = logging.getLogger(__name__)
DEFAULT_CREDS = Path(".txline-credentials.json")


def create_app(creds: TokenCredentials) -> FastAPI:
    app = FastAPI(title="TxLINE Proxy")
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

    @app.get("/fixtures")
    async def fixtures_endpoint():
        async with httpx.AsyncClient() as http:
            return await get_fixtures(http, creds.jwt, creds.api_token)

    async def _odds_events(fixture_id: Optional[int]):
        async for event in stream_odds(creds.jwt, creds.api_token, fixture_id=fixture_id):
            if isinstance(event, Heartbeat):
                yield {"event": "heartbeat", "data": json.dumps({"Ts": event.Ts})}
            else:
                yield {"event": "odds", "data": event.model_dump_json()}

    @app.get("/odds/stream")
    async def odds_stream(fixture_id: Optional[int] = Query(default=None, alias="fixtureId")):
        return EventSourceResponse(_odds_events(fixture_id))

    async def _scores_events(fixture_id: Optional[int]):
        async for event in stream_scores(creds.jwt, creds.api_token, fixture_id=fixture_id):
            if isinstance(event, Heartbeat):
                yield {"event": "heartbeat", "data": json.dumps({"Ts": event.Ts})}
            else:
                yield {"event": "scores", "data": event.model_dump_json()}

    @app.get("/scores/stream")
    async def scores_stream(fixture_id: Optional[int] = Query(default=None, alias="fixtureId")):
        return EventSourceResponse(_scores_events(fixture_id))

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
    creds = load_credentials(Path(credentials))
    if creds is None:
        raise click.ClickException(
            f"No credentials at {credentials}. Run `txline-subscribe` first."
        )
    uvicorn.run(create_app(creds), host=host, port=port)
