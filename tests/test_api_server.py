import asyncio
import json
from contextlib import aclosing
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from click.testing import CliRunner
from httpx import ASGITransport, AsyncClient

from txline.api.server import cli as server_cli
from txline.api.server import create_app, stream_events
from txline.exceptions import TxLineStreamError
from txline.ingest import Ingester, UpstreamCredentials
from txline.ingest import cli as ingest_cli
from txline.models import Fixture, Heartbeat, OddsUpdate, ScoreUpdate, TokenCredentials
from txline.store import REPLAY_LIMIT, FeedStore

FIXTURE = Fixture(
    Ts=1000, StartTime=1781830800000, Competition="Premier League",
    CompetitionId=8, FixtureGroupId=1, Participant1Id=1, Participant1="Forest",
    Participant2Id=2, Participant2="Chelsea", FixtureId=100, Participant1IsHome=True, GameState=4,
)
ODDS = OddsUpdate(
    FixtureId=100, MessageId="match-odds", Ts=1000, Bookmaker="bet365", BookmakerId=1,
    SuperOddsType="1X2_PARTICIPANT_RESULT", InRunning=True, Prices=[2000, 3000, 4000],
)
SCORE = ScoreUpdate(
    fixtureId=100, gameState="H2", startTime=1000, participant1Id=1, participant2Id=2,
    competitionId=8, countryId=1, sportId=1, fixtureGroupId=1, isTeam=True,
    participant1IsHome=True, action="goal", id=2, ts=1000, connectionId=1, seq=1,
)


@pytest.fixture
def store(tmp_path):
    store = FeedStore(tmp_path / "dashboard.sqlite3")
    store.initialize()
    store.replace_fixtures([FIXTURE])
    return store


@pytest.fixture
def ingester(store):
    creds = TokenCredentials(jwt="test-jwt", api_token="test-token")
    ingester = Ingester(store, UpstreamCredentials(creds, None))
    ingester.fixture_ids = store.fixture_ids()
    return ingester


async def test_web_serves_serialized_snapshot_without_upstream_credentials(tmp_path):
    database = tmp_path / "dashboard.sqlite3"
    app = create_app(database)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        assert (await client.get("/healthz")).json() == {"status": "ok", "fixturesCached": False}
        assert (await client.get("/fixtures")).status_code == 503

        store = FeedStore(database)
        store.initialize()
        store.replace_fixtures([
            FIXTURE, FIXTURE.model_copy(update={"FixtureId": 101, "CompetitionId": 121}),
        ])
        response = await client.get("/fixtures", headers={"Origin": "https://example.com"})
        assert response.json() == [{
            "FixtureId": 100, "Participant1": "Forest", "Participant2": "Chelsea",
            "Participant1IsHome": True, "Competition": "Premier League",
            "StartTime": FIXTURE.StartTime, "GameState": 4,
        }]
        assert response.headers["access-control-allow-origin"] == "*"
        assert response.headers["cache-control"] == "no-store"
        assert (await client.get("/healthz")).json() == {"status": "ok", "fixturesCached": True}


async def test_ingester_filters_and_replays_odds_and_scores(store, ingester):
    async def odds(jwt, api_token):
        yield ODDS
        yield ODDS  # reconnect replay
        yield ODDS.model_copy(update={"FixtureId": 999})
        yield ODDS.model_copy(update={"SuperOddsType": "OTHER_MARKET", "MessageId": "other"})
        yield Heartbeat(Ts=1)

    async def scores(jwt, api_token):
        yield SCORE
        yield SCORE.model_copy(update={"connectionId": 2, "seq": 10})
        yield SCORE.model_copy(update={"competitionId": 121})
        yield SCORE.model_copy(update={"score": {"Participant1": {"Goals": 1}}})

    await asyncio.gather(
        ingester.read_upstream("odds", odds), ingester.read_upstream("scores", scores),
    )
    reader = FeedStore(store.path)
    async with aclosing(stream_events(reader, "odds", 100)) as feed:
        first = await anext(feed)
        assert first["event"] == "odds"
        assert json.loads(first["data"])["Prices"] == [2000, 3000, 4000]
        assert json.loads(first["data"])["receivedAt"] > 0
        assert await anext(feed) == {"event": "feed_status", "data": "feed unavailable"}

    async with aclosing(stream_events(reader, "scores", 100)) as feed:
        assert json.loads((await anext(feed))["data"])["fixtureId"] == 100
        correction = json.loads((await anext(feed))["data"])
        assert correction["score"]["Participant1"]["Goals"] == 1
        assert (await anext(feed))["event"] == "feed_status"

    reader.set_feed_status("odds", "live")
    store.append(ODDS.model_copy(update={"MessageId": "next"}))
    async with aclosing(stream_events(reader, "odds", 100, first["id"])) as feed:
        assert json.loads((await anext(feed))["data"])["MessageId"] == "next"
        assert (await anext(feed))["event"] == "heartbeat"
    async with aclosing(stream_events(reader, "odds", 999)) as feed:
        assert (await anext(feed))["event"] == "heartbeat"


@pytest.mark.parametrize("feed", ["odds", "scores"])
async def test_sse_endpoint_uses_fixture_and_cursor(store, feed):
    async def finite_feed(db, selected_feed, fixture_id, last_event_id):
        assert db.path == store.path
        assert (selected_feed, fixture_id, last_event_id) == (feed, 100, "cursor")
        yield {"event": feed, "id": "stored-id", "data": "{}"}

    app = create_app(store.path)
    with patch("txline.api.server.stream_events", finite_feed):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get(
                f"/{feed}/stream?fixtureId=100", headers={"Last-Event-ID": "cursor"},
            )
    assert "text/event-stream" in response.headers["content-type"]
    assert "id: stored-id" in response.text
    assert f"event: {feed}" in response.text


def test_history_pruning_preserves_latest_values_and_removes_expired_fixtures(store):
    store.append(ODDS.model_copy(update={"MarketPeriod": "fulltime"}))
    store.append(ODDS.model_copy(update={"MarketPeriod": "half=1", "MessageId": "half"}))
    for n in range(REPLAY_LIMIT + 3):
        store.append(ODDS.model_copy(update={"Prices": [], "MessageId": f"empty-{n}"}))
    store.append(SCORE.model_copy(update={"score": {"Participant1": {"Goals": 1}}}))
    for n in range(REPLAY_LIMIT + 1):
        store.append(SCORE.model_copy(update={"id": n + 10, "action": "Status"}))
    store.replace_fixtures([FIXTURE])

    epoch, rows, _ = store.read_feed("odds", None, None)
    assert len(rows) == REPLAY_LIMIT + 2  # Latest full-time quote and separate half market.
    assert json.loads(rows[0][1])["MessageId"] == ODDS.MessageId
    assert json.loads(rows[1][1])["MessageId"] == "half"
    assert json.loads(rows[-1][1])["MessageId"] == f"empty-{REPLAY_LIMIT + 2}"
    assert store.read_feed("odds", None, ("f" * 32, rows[-1][0]))[1] == rows
    assert store.read_feed("odds", None, (epoch, rows[-1][0]))[1] == []

    _, scores, _ = store.read_feed("scores", None, None)
    assert len(scores) == REPLAY_LIMIT + 1
    assert json.loads(scores[0][1])["score"] == {"Participant1": {"Goals": 1}}

    store.replace_fixtures([])
    assert store.read_feed("odds", None, None)[1] == []


async def test_fixture_401_reloads_credentials_and_preserves_resolved_league(ingester, tmp_path):
    path = tmp_path / "credentials.json"
    ingester.auth._path = path
    path.write_text(TokenCredentials(jwt="replacement-jwt", api_token="replacement-token")
                    .model_dump_json())
    rejected = httpx.Response(401, request=httpx.Request("GET", "https://example.test"))

    async def upstream(client, jwt, api_token, **kwargs):
        assert kwargs == {"competition_id": 8, "days_after": 3}
        if jwt == "test-jwt":
            rejected.raise_for_status()
        assert (jwt, api_token) == ("replacement-jwt", "replacement-token")
        return [FIXTURE, FIXTURE.model_copy(update={"FixtureId": 2, "CompetitionId": 121})]

    with (
        patch("txline.ingest.get_fixtures_window", upstream),
        patch("txline.ingest.get_guest_jwt") as refresh,
    ):
        async with httpx.AsyncClient() as client:
            await ingester.refresh_fixtures(client)

    refresh.assert_not_called()
    assert ingester.fixture_ids == {100}


async def test_concurrent_feed_401s_share_refresh_and_report_failure(ingester):
    credentials_used = []

    async def upstream(jwt, api_token):
        credentials_used.append((jwt, api_token))
        raise TxLineStreamError("private details", status_code=401)
        yield

    with patch("txline.ingest.get_guest_jwt", AsyncMock(return_value="new-jwt")) as refresh:
        await asyncio.gather(
            ingester.read_upstream("odds", upstream), ingester.read_upstream("scores", upstream),
        )

    refresh.assert_awaited_once()
    assert credentials_used.count(("new-jwt", "test-token")) == 2
    for feed in ("odds", "scores"):
        async with aclosing(stream_events(ingester.store, feed, None)) as events:
            assert await anext(events) == {"event": "feed_status", "data": "authentication failed"}


def test_only_ingester_cli_requires_credentials(tmp_path):
    runner = CliRunner()
    result = runner.invoke(ingest_cli, ["--credentials", str(tmp_path / "missing.json")])
    assert result.exit_code != 0
    assert "No credentials" in result.output
    with patch("txline.api.server.uvicorn.run") as run:
        result = runner.invoke(server_cli, ["--database", str(tmp_path / "dashboard.sqlite3")])
    assert result.exit_code == 0
    run.assert_called_once()


async def test_single_ingester_supplies_multiple_dashboard_connections(tmp_path):
    store = FeedStore(tmp_path / "shared.sqlite3")
    creds = TokenCredentials(jwt="test-jwt", api_token="test-token")
    collector = Ingester(store, UpstreamCredentials(creds, None))
    connections = []
    odds_written = asyncio.Event()
    scores_written = asyncio.Event()

    async def odds(jwt, api_token):
        connections.append(("odds", jwt, api_token))
        yield ODDS
        odds_written.set()
        await asyncio.Future()

    async def scores(jwt, api_token):
        connections.append(("scores", jwt, api_token))
        yield SCORE
        scores_written.set()
        await asyncio.Future()

    with (
        patch("txline.ingest.get_fixtures_window", AsyncMock(return_value=[FIXTURE])),
        patch("txline.ingest.get_odds_history", AsyncMock(return_value=[])),
        patch("txline.ingest.stream_odds", odds),
        patch("txline.ingest.stream_scores", scores),
    ):
        task = asyncio.create_task(collector.run())
        try:
            await asyncio.wait_for(
                asyncio.gather(odds_written.wait(), scores_written.wait()), timeout=5,
            )
            async with (
                aclosing(stream_events(FeedStore(store.path), "odds", None)) as browser_one,
                aclosing(stream_events(FeedStore(store.path), "odds", None)) as browser_two,
            ):
                first, second = await asyncio.gather(anext(browser_one), anext(browser_two))
                assert first == second
                assert json.loads(first["data"])["Prices"] == ODDS.Prices
            assert sorted(connections) == [
                ("odds", "test-jwt", "test-token"), ("scores", "test-jwt", "test-token"),
            ]
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task


async def test_backfill_merges_with_live_odds_and_keeps_recent_market_history(store, ingester):
    newest = ODDS.model_copy(update={"Ts": 5000, "MessageId": "live"})
    store.append(newest)
    archive = [
        newest,
        *[ODDS.model_copy(update={"Ts": n, "MessageId": f"old-{n}"})
          for n in range(REPLAY_LIMIT + 2)],
        ODDS.model_copy(update={"Ts": 1000, "MessageId": "half", "MarketPeriod": "half=1"}),
        ODDS.model_copy(update={"FixtureId": 101, "MessageId": "wrong-fixture"}),
        ODDS.model_copy(update={"SuperOddsType": "OTHER_MARKET", "MessageId": "wrong-market"}),
    ]

    def upstream(request):
        assert request.url.path == "/api/odds/updates/100"
        assert request.headers["authorization"] == "Bearer test-jwt"
        assert request.headers["x-api-token"] == "test-token"
        return httpx.Response(200, json=[event.model_dump() for event in archive])

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        assert await ingester.backfill_odds(client, 100) == REPLAY_LIMIT
        assert await ingester.backfill_odds(client, 100) == 0

    _, rows, _ = store.read_feed("odds", 100, None)
    updates = [json.loads(payload) for _, payload in rows]
    assert len(updates) == REPLAY_LIMIT + 1
    assert updates[0]["MessageId"] == "live"
    assert "archived" not in updates[0]
    assert all(update["archived"] for update in updates[1:])
    assert updates[1]["MessageId"] == "old-3"
    assert updates[-1]["MessageId"] == "half"
