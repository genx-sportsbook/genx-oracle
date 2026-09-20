"""Tests for txline/rest/fixtures.py — get_fixtures_window's day-bucket merge."""
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from txline.models import Fixture
from txline.rest.fixtures import get_fixtures_window


def _fixture(fid: int, comp: str = "MLS") -> Fixture:
    return Fixture(
        Ts=0, StartTime=0, Competition=comp, CompetitionId=1,
        FixtureGroupId=1, Participant1Id=1, Participant1="A",
        Participant2Id=2, Participant2="B", FixtureId=fid,
        Participant1IsHome=True,
    )


@pytest.mark.asyncio
async def test_merges_fixtures_across_days():
    today = int(datetime.now(timezone.utc).timestamp() // 86400)

    async def fake_get_fixtures(client, jwt, api_token, start_epoch_day=None, competition_id=None):
        if start_epoch_day == today - 1:
            return [_fixture(1)]
        if start_epoch_day == today:
            return [_fixture(2)]
        return []

    with patch("txline.rest.fixtures.get_fixtures", new=fake_get_fixtures):
        result = await get_fixtures_window(client=None, jwt="j", api_token="t")

    fids = {f.FixtureId for f in result}
    assert fids == {1, 2}


@pytest.mark.asyncio
async def test_dedupes_fixture_present_in_multiple_days():
    async def fake_get_fixtures(client, jwt, api_token, start_epoch_day=None, competition_id=None):
        return [_fixture(1)]

    with patch("txline.rest.fixtures.get_fixtures", new=fake_get_fixtures):
        result = await get_fixtures_window(client=None, jwt="j", api_token="t")

    assert len(result) == 1
    assert result[0].FixtureId == 1


@pytest.mark.asyncio
async def test_default_window_is_yesterday_and_today():
    seen_days = []

    async def fake_get_fixtures(client, jwt, api_token, start_epoch_day=None, competition_id=None):
        seen_days.append(start_epoch_day)
        return []

    with patch("txline.rest.fixtures.get_fixtures", new=fake_get_fixtures):
        await get_fixtures_window(client=None, jwt="j", api_token="t")

    today = int(datetime.now(timezone.utc).timestamp() // 86400)
    assert sorted(seen_days) == [today - 1, today]


@pytest.mark.asyncio
async def test_competition_id_passed_through_to_each_day():
    captured = []

    async def fake_get_fixtures(client, jwt, api_token, start_epoch_day=None, competition_id=None):
        captured.append(competition_id)
        return []

    with patch("txline.rest.fixtures.get_fixtures", new=fake_get_fixtures):
        await get_fixtures_window(client=None, jwt="j", api_token="t", competition_id=42)

    assert captured == [42, 42]
