"""Read the Match Odds archive for an individual fixture."""

import asyncio
import json
import logging

import httpx
from pydantic import ValidationError

from txline.models import OddsUpdate
from txline.store import MATCH_ODDS_TYPE

ODDS_HISTORY_URL = "https://txline.txodds.com/api/odds/updates"
logger = logging.getLogger(__name__)


def _parse_history(body: bytes, fixture_id: int) -> list[OddsUpdate]:
    rows = json.loads(body)
    if not isinstance(rows, list):
        raise ValueError("Expected a list of odds records")
    events = []
    invalid = 0
    for row in rows:
        if not isinstance(row, dict) or row.get("SuperOddsType") != MATCH_ODDS_TYPE:
            continue
        try:
            event = OddsUpdate.model_validate(row)
        except ValidationError:
            invalid += 1
            continue
        if event.FixtureId == fixture_id:
            events.append(event)
    if invalid:
        logger.warning("Skipped %d invalid Match Odds records for fixture %d", invalid, fixture_id)
    return events


async def get_odds_history(
    client: httpx.AsyncClient, jwt: str, api_token: str, fixture_id: int,
) -> list[OddsUpdate]:
    response = await client.get(
        f"{ODDS_HISTORY_URL}/{fixture_id}",
        headers={"Authorization": f"Bearer {jwt}", "X-Api-Token": api_token},
    )
    if response.status_code == 404:
        return []
    response.raise_for_status()
    return await asyncio.to_thread(_parse_history, response.content, fixture_id)
