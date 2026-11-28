"""Serve the dashboard and stream data from the local TxLINE database."""

import asyncio
import json
import sqlite3
import time
from collections.abc import AsyncIterator
from pathlib import Path

import click
import uvicorn
from fastapi import FastAPI, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse

from txline.store import DEFAULT_DATABASE, FIXTURES_CACHE_TTL, FeedStore

POLL_INTERVAL = 1
HEARTBEAT_INTERVAL = 10
FEED_STALE_AFTER = 75


def parse_cursor(value: str) -> tuple[str, int] | None:
    epoch, _, sequence = value.partition(":")
    if len(epoch) == 32 and sequence.isascii() and sequence.isdecimal() and len(sequence) <= 19:
        number = int(sequence)
        if number < 2**63:
            return epoch, number
    return None


async def stream_events(
    store: FeedStore, feed: str, fixture_id: int | None, last_event_id: str = "",
) -> AsyncIterator[dict[str, str]]:
    cursor = parse_cursor(last_event_id)
    last_status = None
    next_heartbeat = 0.0
    while True:
        try:
            epoch, rows, status = await asyncio.to_thread(store.read_feed, feed, fixture_id, cursor)
        except sqlite3.OperationalError:
            epoch, rows, status = "", [], None

        for sequence, payload in rows:
            cursor = (epoch, sequence)
            yield {"id": f"{epoch}:{sequence}", "event": feed, "data": payload}
        if rows:
            continue  # Drain the backlog before waiting for more rows.

        now = time.time()
        if status is None:
            state = "connecting"
        elif now - status[1] > FEED_STALE_AFTER:
            state = "feed unavailable"
        else:
            state = status[0]
        if state == "live" and (now >= next_heartbeat or state != last_status):
            yield {"event": "heartbeat", "data": json.dumps({"Ts": int(now * 1000)})}
            next_heartbeat = now + HEARTBEAT_INTERVAL
        elif state != "live" and state != last_status:
            yield {"event": "feed_status", "data": state}
        last_status = state
        await asyncio.sleep(POLL_INTERVAL)


def create_app(database: Path = DEFAULT_DATABASE) -> FastAPI:
    store = FeedStore(database)
    app = FastAPI(title="TxLINE Dashboard")
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["GET"], allow_headers=["*"],
    )

    @app.middleware("http")
    async def no_cache(request, call_next):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    async def read_snapshot():
        try:
            return await asyncio.to_thread(store.snapshot)
        except sqlite3.OperationalError:
            # The ingester may still be initializing the database during startup.
            return None

    @app.get("/healthz")
    async def healthz():
        snapshot = await read_snapshot()
        fresh = snapshot is not None and time.time() - snapshot[0] <= FIXTURES_CACHE_TTL
        return {"status": "ok", "fixturesCached": fresh}

    @app.get("/fixtures")
    async def fixtures_endpoint():
        snapshot = await read_snapshot()
        if snapshot is None:
            return Response(
                content=b'{"detail":"fixture snapshot unavailable"}',
                media_type="application/json", status_code=503,
            )
        return Response(content=snapshot[1], media_type="application/json")

    @app.get("/odds/stream")
    async def odds_stream(request: Request, fixture_id: int | None = Query(None, alias="fixtureId")):
        return EventSourceResponse(
            stream_events(store, "odds", fixture_id, request.headers.get("last-event-id", "")),
        )

    @app.get("/scores/stream")
    async def scores_stream(
        request: Request, fixture_id: int | None = Query(None, alias="fixtureId"),
    ):
        return EventSourceResponse(
            stream_events(store, "scores", fixture_id, request.headers.get("last-event-id", "")),
        )

    app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
    return app


@click.command()
@click.option("--database", default=DEFAULT_DATABASE, type=click.Path(path_type=Path),
              envvar="TXLINE_DATABASE", show_default=True)
@click.option("--host", default="0.0.0.0", show_default=True)
@click.option("--port", default=8000, show_default=True)
def cli(database: Path, host: str, port: int) -> None:
    """Serve the TxLINE dashboard without opening upstream connections."""
    uvicorn.run(create_app(database), host=host, port=port)


if __name__ == "__main__":
    cli()
