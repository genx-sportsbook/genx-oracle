"""REST client for fixture snapshots — GET /api/fixtures/snapshot."""

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

import httpx

from txline.models import Fixture

logger = logging.getLogger(__name__)

FIXTURES_URL = "https://txline.txodds.com/api/fixtures/snapshot"


async def get_fixtures(
    client: httpx.AsyncClient,
    jwt: str,
    api_token: str,
    start_epoch_day: Optional[int] = None,
    competition_id: Optional[int] = None,
) -> list[Fixture]:
    headers = {
        "Authorization": f"Bearer {jwt}",
        "X-Api-Token": api_token,
    }
    params = {}
    if start_epoch_day is not None:
        params["startEpochDay"] = str(start_epoch_day)
    if competition_id is not None:
        params["competitionId"] = str(competition_id)

    resp = await client.get(FIXTURES_URL, headers=headers, params=params)
    resp.raise_for_status()
    return [Fixture(**item) for item in resp.json()]


async def get_fixtures_window(
    client: httpx.AsyncClient,
    jwt: str,
    api_token: str,
    competition_id: Optional[int] = None,
    days_before: int = 1,
    days_after: int = 0,
) -> list[Fixture]:
    """
    Merges /fixtures/snapshot across a small window of day-buckets.

    The endpoint scopes fixtures to a startEpochDay bucket reflecting each
    fixture's scheduled UTC day, defaulting to "today" when the param is
    omitted. A US evening kickoff often lands in *yesterday's* UTC bucket
    and stays there even while the match is still live well past UTC
    midnight — fetching only "today" silently drops those in-progress
    fixtures from name/competition resolution. They keep streaming odds and
    scores fine regardless (that data isn't bucketed by day); they just show
    up as a bare numeric FixtureId with no name once this happens. One day's
    margin covers it — the boundary only bites backward, since a fixture
    starting later today is already in today's bucket.
    """
    today = int(datetime.now(timezone.utc).timestamp() // 86400)
    days = range(today - days_before, today + days_after + 1)
    results = await asyncio.gather(*[
        get_fixtures(client, jwt, api_token, start_epoch_day=day, competition_id=competition_id)
        for day in days
    ])
    merged: dict[int, Fixture] = {}
    for day_fixtures in results:
        for f in day_fixtures:
            merged[f.FixtureId] = f
    return list(merged.values())
