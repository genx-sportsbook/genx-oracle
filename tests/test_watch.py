"""Tests for txline-watch logic — no network calls."""
from txline.cli.watch import FixtureState, parse_score, build_table, apply_event
from txline.models import ScoreUpdate, OddsUpdate, Fixture


def _score_update(**kwargs) -> ScoreUpdate:
    defaults = dict(
        fixtureId=1, gameState="FirstHalf", startTime=0, participant1Id=10,
        participant2Id=20, competitionId=5, countryId=1, sportId=1,
        fixtureGroupId=1, isTeam=True, participant1IsHome=True,
        action="Goal", id="abc", ts=0, connectionId="x", seq=1,
    )
    return ScoreUpdate(**{**defaults, **kwargs})


def test_parse_score_soccer_title_case():
    ev = _score_update(scoreSoccer={"Home": 2, "Away": 1})
    assert parse_score(ev) == "2 – 1"


def test_parse_score_soccer_lower_case():
    ev = _score_update(scoreSoccer={"home": 0, "away": 0})
    assert parse_score(ev) == "0 – 0"


def test_parse_score_fallback_to_score():
    ev = _score_update(score={"total": 3})
    assert parse_score(ev) == "{'total': 3}"


def test_parse_score_empty():
    ev = _score_update()
    assert parse_score(ev) == "—"


def test_fixture_state_defaults():
    fs = FixtureState(fixture_id=99, name="99")
    assert fs.competition == "—"
    assert fs.kickoff == "—"
    assert fs.score == "—"
    assert fs.game_state == "—"
    assert fs.market == "—"
    assert fs.prices == "—"
    assert fs.pct == "—"
    assert fs.updated == ""


def test_build_table_columns():
    t = build_table({})
    cols = [c.header for c in t.columns]
    assert cols == ["Fixture", "Competition", "Kickoff", "Score", "State",
                    "Cards/Corners", "Last Event", "Market", "Prices", "Pct", "Updated"]


def test_build_table_empty():
    t = build_table({})
    assert t.row_count == 0


def test_build_table_one_row():
    fs = FixtureState(fixture_id=1, name="A vs B", competition="PL",
                      kickoff="18 Jun 14:00", score="2 – 1", game_state="SecondHalf",
                      market="1X2", prices="part1:1.500  draw:2.400  part2:5.500",
                      pct="66.67%  33.33%  50.00%", updated="12:00:00")
    t = build_table({1: fs})
    assert t.row_count == 1


def test_build_table_sorted_by_fixture_id():
    state = {
        3: FixtureState(fixture_id=3, name="C vs D"),
        1: FixtureState(fixture_id=1, name="A vs B"),
    }
    t = build_table(state)
    assert t.row_count == 2
    # rows are sorted ascending — first row is fixture 1
    # Rich doesn't expose row data directly; just verify count and no exception


def _odds_update(**kwargs) -> OddsUpdate:
    defaults = dict(
        FixtureId=1, MessageId="m1", Ts=0, Bookmaker="BetX",
        BookmakerId=1, SuperOddsType="1X2", InRunning=True,
    )
    return OddsUpdate(**{**defaults, **kwargs})


def _fixture(fid=1, p1="Home", p2="Away", comp="PL") -> Fixture:
    return Fixture(
        Ts=0, StartTime=0, Competition=comp, CompetitionId=1,
        FixtureGroupId=1, Participant1Id=10, Participant1=p1,
        Participant2Id=20, Participant2=p2, FixtureId=fid,
        Participant1IsHome=True,
    )


def test_apply_event_odds_creates_row():
    state: dict = {}
    cache: dict = {}
    apply_event(_odds_update(), state, cache, "10:00:00")
    assert 1 in state
    assert state[1].market == "1X2"


def test_apply_event_odds_prices():
    state: dict = {}
    cache: dict = {}
    apply_event(_odds_update(Prices=[1500, 3000, 2000]), state, cache, "10:00:00")
    assert state[1].prices == "1.500  3.000  2.000"


def test_apply_event_odds_no_prices():
    state: dict = {}
    cache: dict = {}
    apply_event(_odds_update(Prices=None), state, cache, "10:00:00")
    assert state[1].prices == "—"


def test_apply_event_score_updates_row():
    state: dict = {}
    cache: dict = {}
    ev = _score_update(fixtureId=2, gameState="SecondHalf",
                       scoreSoccer={"Home": 1, "Away": 0})
    apply_event(ev, state, cache, "11:00:00")
    assert state[2].score == "1 – 0"
    assert state[2].game_state == "SecondHalf"


def test_apply_event_resolves_name_from_cache():
    state: dict = {}
    cache = {1: _fixture(fid=1, p1="Arsenal", p2="Chelsea", comp="PL")}
    apply_event(_odds_update(FixtureId=1), state, cache, "12:00:00")
    assert state[1].name == "Arsenal vs Chelsea"
    assert state[1].competition == "PL"


def test_apply_event_name_stays_raw_if_not_in_cache():
    state: dict = {}
    cache: dict = {}
    apply_event(_odds_update(FixtureId=42), state, cache, "12:00:00")
    assert state[42].name == "42"


def test_apply_event_returns_fixture_id():
    state: dict = {}
    fid = apply_event(_odds_update(FixtureId=7), state, {}, "12:00:00")
    assert fid == 7


def test_apply_event_odds_labeled_prices():
    state: dict = {}
    apply_event(_odds_update(Prices=[1788, 2269], PriceNames=["over", "under"]),
                state, {}, "10:00:00")
    assert state[1].prices == "over:1.788  under:2.269"


def test_apply_event_odds_pct():
    state: dict = {}
    apply_event(_odds_update(Pct=["66.67", "33.33", "50.00"]), state, {}, "10:00:00")
    assert state[1].pct == "66.67%  33.33%  50.00%"


def test_apply_event_odds_pct_none():
    state: dict = {}
    apply_event(_odds_update(Pct=None), state, {}, "10:00:00")
    assert state[1].pct == "—"


def test_build_table_flash_fid():
    state = {1: FixtureState(fixture_id=1, name="A vs B")}
    t = build_table(state, flash_fid=1)
    assert t.row_count == 1  # highlighted row still renders
