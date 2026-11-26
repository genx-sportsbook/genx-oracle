import asyncio

import httpx
import pytest
from httpx import AsyncClient, ASGITransport
from unittest.mock import patch, AsyncMock
from txline.api.server import create_app
from txline.exceptions import TxLineStreamError
from txline.models import Fixture, OddsUpdate, ScoreUpdate, Heartbeat, TokenCredentials


@pytest.fixture
def creds():
    return TokenCredentials(jwt="test-jwt", api_token="test-token")


@pytest.fixture
def app(creds):
    return create_app(creds)


FIXTURE_1 = Fixture(
    Ts=1000, StartTime=1781830800000, Competition="England - Premier League",
    CompetitionId=1, FixtureGroupId=1, Participant1Id=1,
    Participant1="Mexico", Participant2Id=2, Participant2="South Korea",
    FixtureId=17588223, Participant1IsHome=True,
)


async def test_fixtures_returns_list(app):
    with patch("txline.api.server.get_fixtures_window", new=AsyncMock(return_value=[FIXTURE_1])):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.get("/fixtures")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["FixtureId"] == 17588223
    assert data[0]["Competition"] == "England - Premier League"


async def test_fixtures_passes_credentials(app):
    captured = {}

    async def mock_get_fixtures(http, jwt, api_token, **kwargs):
        captured["jwt"] = jwt
        captured["api_token"] = api_token
        captured["days_after"] = kwargs["days_after"]
        return []

    with patch("txline.api.server.get_fixtures_window", new=mock_get_fixtures):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            await c.get("/fixtures")

    assert captured["jwt"] == "test-jwt"
    assert captured["api_token"] == "test-token"
    assert captured["days_after"] == 3


async def test_fixtures_only_return_english_premier_league(app):
    fixtures = [
        FIXTURE_1,
        FIXTURE_1.model_copy(update={"FixtureId": 2, "Competition": "International Friendlies"}),
        FIXTURE_1.model_copy(update={"FixtureId": 3, "Competition": "Russian Premier League"}),
        FIXTURE_1.model_copy(update={"FixtureId": 4, "Competition": "NBA"}),
        FIXTURE_1.model_copy(update={"FixtureId": 5, "Competition": "World Cup"}),
        FIXTURE_1.model_copy(update={"FixtureId": 6, "Competition": "Friendlies"}),
        FIXTURE_1.model_copy(update={"FixtureId": 7, "Competition": "Premier League"}),
        FIXTURE_1.model_copy(update={"FixtureId": 8, "Competition": "Premier League 2"}),
    ]
    async def fetch_window(client, jwt, api_token, *, days_after, include_competition):
        return [f for f in fixtures if include_competition(f.Competition)]

    with patch("txline.api.server.get_fixtures_window", new=fetch_window):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            response = await c.get("/fixtures")

    assert [fixture["FixtureId"] for fixture in response.json()] == [FIXTURE_1.FixtureId, 7]


async def test_odds_stream_sse_format(app):
    async def mock_odds(jwt, api_token, fixture_id=None, last_event_id=None):
        match_odds = OddsUpdate(
            FixtureId=FIXTURE_1.FixtureId, MessageId="match-odds", Ts=1000, Bookmaker="bet365",
            BookmakerId=1, SuperOddsType="1X2_PARTICIPANT_RESULT", InRunning=False,
        )
        yield match_odds
        yield match_odds.model_copy(update={
            "MessageId": "other-market", "SuperOddsType": "EUROHANDICAP_PARTICIPANT_POINTS",
        })
        yield match_odds.model_copy(update={"MessageId": "other-fixture", "FixtureId": 10})
        yield Heartbeat(Ts=2000)

    with (
        patch("txline.api.server.stream_odds", new=mock_odds),
        patch("txline.api.server.get_fixtures_window", return_value=[FIXTURE_1]),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            async with c.stream("GET", "/odds/stream") as r:
                assert r.status_code == 200
                assert "text/event-stream" in r.headers["content-type"]
                content = b""
                async for chunk in r.aiter_bytes():
                    content += chunk

    text = content.decode()
    assert "event: odds" in text
    assert '"MessageId":"match-odds"' in text
    assert "other-market" not in text
    assert "other-fixture" not in text
    assert "event: heartbeat" in text


async def test_odds_stream_fixture_id_passthrough(app):
    captured = {}

    async def mock_odds(jwt, api_token, fixture_id=None, last_event_id=None):
        captured["fixture_id"] = fixture_id
        yield Heartbeat(Ts=1000)

    with patch("txline.api.server.stream_odds", new=mock_odds):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            async with c.stream("GET", "/odds/stream?fixtureId=42") as r:
                async for _ in r.aiter_bytes():
                    pass

    assert captured["fixture_id"] == 42


async def test_scores_stream_sse_format(app):
    async def mock_scores(jwt, api_token, fixture_id=None, last_event_id=None):
        score = ScoreUpdate(
            fixtureId=FIXTURE_1.FixtureId, gameState="active", startTime=1000,
            participant1Id=1, participant2Id=2, competitionId=1,
            countryId=1, sportId=1, fixtureGroupId=1,
            isTeam=True, participant1IsHome=True,
            action="goal", id=1, ts=1000,
            connectionId=1, seq=1,
        )
        yield score
        yield score.model_copy(update={"fixtureId": 99})
        yield Heartbeat(Ts=3000)

    with (
        patch("txline.api.server.stream_scores", new=mock_scores),
        patch("txline.api.server.get_fixtures_window", return_value=[FIXTURE_1]),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            async with c.stream("GET", "/scores/stream") as r:
                assert r.status_code == 200
                assert "text/event-stream" in r.headers["content-type"]
                content = b""
                async for chunk in r.aiter_bytes():
                    content += chunk

    text = content.decode()
    assert "event: scores" in text
    assert f'"fixtureId":{FIXTURE_1.FixtureId}' in text
    assert '"fixtureId":99' not in text
    assert "event: heartbeat" in text


async def test_scores_stream_fixture_id_passthrough(app):
    captured = {}

    async def mock_scores(jwt, api_token, fixture_id=None, last_event_id=None):
        captured["fixture_id"] = fixture_id
        yield Heartbeat(Ts=1000)

    with patch("txline.api.server.stream_scores", new=mock_scores):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            async with c.stream("GET", "/scores/stream?fixtureId=7") as r:
                async for _ in r.aiter_bytes():
                    pass

    assert captured["fixture_id"] == 7


async def test_cors_header_present(app):
    with patch("txline.api.server.get_fixtures_window", new=AsyncMock(return_value=[])):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.get("/fixtures", headers={"Origin": "https://example.com"})
    assert r.headers.get("access-control-allow-origin") == "*"


def test_cli_exits_on_missing_credentials(tmp_path):
    from click.testing import CliRunner
    from txline.api.server import cli

    runner = CliRunner()
    result = runner.invoke(cli, ["--credentials", str(tmp_path / "nope.json")])
    assert result.exit_code != 0
    assert "No credentials" in result.output


async def test_healthz_does_no_upstream_work(app):
    """The probe target must never touch TxLINE — that's what made the old
    readiness probe (pointed at /fixtures) time out and flap the pod."""
    called = False

    async def mock_get_fixtures(*args, **kwargs):
        nonlocal called
        called = True
        return []

    with patch("txline.api.server.get_fixtures_window", new=mock_get_fixtures):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.get("/healthz")

    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert called is False


async def test_fixtures_trimmed_to_fields_the_dashboard_uses(app):
    with patch("txline.api.server.get_fixtures_window", new=AsyncMock(return_value=[FIXTURE_1])):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.get("/fixtures")

    assert set(r.json()[0]) == {
        "FixtureId", "Participant1", "Participant2", "Competition", "StartTime",
    }


async def test_fixtures_fetched_once_and_served_from_cache(app):
    calls = 0

    async def mock_get_fixtures(*args, **kwargs):
        nonlocal calls
        calls += 1
        return [FIXTURE_1]

    with patch("txline.api.server.get_fixtures_window", new=mock_get_fixtures):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            first = await c.get("/fixtures")
            second = await c.get("/fixtures")

    assert calls == 1
    assert first.content == second.content


async def test_concurrent_cold_requests_fetch_once(app):
    """Single-flight: without the lock each concurrent caller would start its
    own ~68MB fetch and ~600MB-peak parse."""
    calls = 0

    async def mock_get_fixtures(*args, **kwargs):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return [FIXTURE_1]

    with patch("txline.api.server.get_fixtures_window", new=mock_get_fixtures):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            results = await asyncio.gather(*[c.get("/fixtures") for _ in range(5)])

    assert calls == 1
    assert all(r.status_code == 200 for r in results)


async def test_fixtures_returns_503_when_upstream_fails_with_empty_cache(app):
    with patch("txline.api.server.get_fixtures_window",
               new=AsyncMock(side_effect=httpx.HTTPError("boom"))):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            r = await c.get("/fixtures")

    assert r.status_code == 503


async def test_concurrent_feed_401s_share_guest_jwt_refresh(app):
    credentials_used = []

    async def upstream(jwt, api_token, fixture_id=None):
        credentials_used.append((jwt, api_token))
        if jwt == "test-jwt":
            raise TxLineStreamError("rejected", status_code=401)
        yield Heartbeat(Ts=2000)

    async def new_jwt(client):
        await asyncio.sleep(0.01)
        return "new-jwt"

    with (
        patch("txline.api.server.stream_odds", upstream),
        patch("txline.api.server.stream_scores", upstream),
        patch("txline.api.server.get_guest_jwt", side_effect=new_jwt) as refresh,
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            responses = await asyncio.gather(c.get("/odds/stream"), c.get("/scores/stream"))

    refresh.assert_awaited_once()
    assert credentials_used.count(("new-jwt", "test-token")) == 2
    assert all("event: heartbeat" in response.text for response in responses)


async def test_repeated_stream_401_reports_authentication_failure(app):
    upstream = AsyncMock(side_effect=TxLineStreamError("private details", status_code=401))

    async def odds(*args, **kwargs):
        yield await upstream(*args, **kwargs)

    with (
        patch("txline.api.server.stream_odds", odds),
        patch("txline.api.server.get_guest_jwt", return_value="new-jwt") as refresh,
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            first = await c.get("/odds/stream")
            second = await c.get("/odds/stream")

    refresh.assert_awaited_once()
    assert upstream.await_count == 3
    for response in (first, second):
        assert "event: feed_status" in response.text
        assert "data: authentication failed" in response.text
        assert "private details" not in response.text


async def test_fixture_401_loads_replaced_credentials_file(creds, tmp_path):
    path = tmp_path / "credentials.json"
    app = create_app(creds, path)
    path.write_text(TokenCredentials(jwt="replacement-jwt", api_token="replacement-token")
                    .model_dump_json())
    rejected = httpx.Response(401, request=httpx.Request("GET", "https://example.test"))

    async def upstream(client, jwt, api_token, **kwargs):
        if jwt == "test-jwt":
            rejected.raise_for_status()
        assert (jwt, api_token) == ("replacement-jwt", "replacement-token")
        return [FIXTURE_1]

    with (
        patch("txline.api.server.get_fixtures_window", upstream),
        patch("txline.api.server.get_guest_jwt") as refresh,
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            response = await c.get("/fixtures")

    refresh.assert_not_called()
    assert response.json()[0]["FixtureId"] == FIXTURE_1.FixtureId
