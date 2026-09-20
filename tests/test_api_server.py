import pytest
from httpx import AsyncClient, ASGITransport
from unittest.mock import patch, AsyncMock
from txline.api.server import create_app
from txline.models import Fixture, OddsUpdate, ScoreUpdate, Heartbeat, TokenCredentials


@pytest.fixture
def creds():
    return TokenCredentials(jwt="test-jwt", api_token="test-token")


@pytest.fixture
def app(creds):
    return create_app(creds)


FIXTURE_1 = Fixture(
    Ts=1000, StartTime=1781830800000, Competition="World Cup",
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
    assert data[0]["Competition"] == "World Cup"


async def test_fixtures_passes_credentials(app):
    captured = {}

    async def mock_get_fixtures(http, jwt, api_token, **kwargs):
        captured["jwt"] = jwt
        captured["api_token"] = api_token
        return []

    with patch("txline.api.server.get_fixtures_window", new=mock_get_fixtures):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            await c.get("/fixtures")

    assert captured["jwt"] == "test-jwt"
    assert captured["api_token"] == "test-token"


async def test_odds_stream_sse_format(app):
    async def mock_odds(jwt, api_token, fixture_id=None, last_event_id=None):
        yield OddsUpdate(
            FixtureId=1, MessageId="m1", Ts=1000, Bookmaker="bet365",
            BookmakerId=1, SuperOddsType="1x2", InRunning=False,
        )
        yield Heartbeat(Ts=2000)

    with patch("txline.api.server.stream_odds", new=mock_odds):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            async with c.stream("GET", "/odds/stream") as r:
                assert r.status_code == 200
                assert "text/event-stream" in r.headers["content-type"]
                content = b""
                async for chunk in r.aiter_bytes():
                    content += chunk

    text = content.decode()
    assert "event: odds" in text
    assert '"FixtureId":1' in text
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
        yield ScoreUpdate(
            fixtureId=99, gameState="active", startTime=1000,
            participant1Id=1, participant2Id=2, competitionId=1,
            countryId=1, sportId=1, fixtureGroupId=1,
            isTeam=True, participant1IsHome=True,
            action="goal", id="s1", ts=1000,
            connectionId="conn1", seq=1,
        )
        yield Heartbeat(Ts=3000)

    with patch("txline.api.server.stream_scores", new=mock_scores):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            async with c.stream("GET", "/scores/stream") as r:
                assert r.status_code == 200
                assert "text/event-stream" in r.headers["content-type"]
                content = b""
                async for chunk in r.aiter_bytes():
                    content += chunk

    text = content.decode()
    assert "event: scores" in text
    assert '"fixtureId":99' in text
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
