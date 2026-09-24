"""Real-time SSE stream of score updates from GET /api/scores/stream."""

import json
import logging
from collections.abc import AsyncIterator
from typing import Optional

import httpx
from httpx_sse import aconnect_sse

from txline.exceptions import TxLineStreamError
from txline.models import ScoreUpdate, Heartbeat

logger = logging.getLogger(__name__)

STREAM_URL = "https://txline.txodds.com/api/scores/stream"


async def stream_scores(
    jwt: str,
    api_token: str,
    fixture_id: Optional[int] = None,
    last_event_id: Optional[str] = None,
) -> AsyncIterator[ScoreUpdate | Heartbeat]:
    """
    Yields ScoreUpdate or Heartbeat events from the live SSE stream.
    """
    headers = {
        "Authorization": f"Bearer {jwt}",
        "X-Api-Token": api_token,
    }
    if last_event_id:
        headers["Last-Event-ID"] = last_event_id

    params = {}
    if fixture_id is not None:
        params["fixtureId"] = str(fixture_id)

    async with httpx.AsyncClient(timeout=None) as client:
        async with aconnect_sse(client, "GET", STREAM_URL, headers=headers, params=params) as src:
            if src.response.status_code != 200:
                body = (await src.response.aread()).decode("utf-8", errors="replace").strip()
                raise TxLineStreamError(
                    f"Scores stream request failed (status={src.response.status_code}, "
                    f"fixture_id={fixture_id}): {body or '(empty response body)'}"
                )
            async for event in src.aiter_sse():
                if event.event == "heartbeat":
                    try:
                        yield Heartbeat(**json.loads(event.data))
                    except Exception:
                        yield Heartbeat(Ts=0)
                    continue
                if not event.data:
                    continue
                try:
                    yield ScoreUpdate(**json.loads(event.data))
                except Exception as exc:
                    logger.warning("Failed to parse score event: %s — %s", event.data[:120], exc)
