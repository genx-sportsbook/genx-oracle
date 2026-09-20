"""Tests for txline/soccer.py — GameState labels and score/event decoding."""
from txline.models import ScoreUpdate
from txline.soccer import describe_event, game_state_label, is_live_state, score_breakdown


def _score_update(**kwargs) -> ScoreUpdate:
    defaults = dict(
        fixtureId=1, gameState="H1", startTime=0, participant1Id=10,
        participant2Id=20, competitionId=5, countryId=1, sportId=1,
        fixtureGroupId=1, isTeam=True, participant1IsHome=True,
        action="Goal", id="abc", ts=0, connectionId="x", seq=1,
    )
    return ScoreUpdate(**{**defaults, **kwargs})


def test_game_state_label_by_id():
    assert game_state_label(1) == "Not Started"
    assert game_state_label(4) == "2nd Half"
    assert game_state_label(19) == "Postponed"


def test_game_state_label_by_code():
    assert game_state_label("H1") == "1st Half"
    assert game_state_label("FT") == "FT"  # unmapped code falls back to itself


def test_game_state_label_none():
    assert game_state_label(None) == "—"


def test_game_state_label_unknown_id():
    assert game_state_label(999) == "Unknown (999)"


def test_is_live_state():
    assert is_live_state("1st Half") is True
    assert is_live_state("Half Time") is False
    assert is_live_state("Not Started") is False


def test_score_breakdown_title_case():
    ev = _score_update(scoreSoccer={
        "Participant1": {"Total": {"Goals": 2, "YellowCards": 1, "RedCards": 0, "Corners": 5}},
        "Participant2": {"Total": {"Goals": 1, "YellowCards": 0, "RedCards": 1, "Corners": 3}},
    })
    b = score_breakdown(ev)
    assert b["participant1"] == {"goals": 2, "yellow_cards": 1, "red_cards": 0, "corners": 5}
    assert b["participant2"] == {"goals": 1, "yellow_cards": 0, "red_cards": 1, "corners": 3}


def test_score_breakdown_camel_case():
    ev = _score_update(scoreSoccer={
        "participant1": {"total": {"goals": 3, "yellowCards": 2, "redCards": 0, "corners": 7}},
        "participant2": {"total": {"goals": 0, "yellowCards": 1, "redCards": 0, "corners": 2}},
    })
    b = score_breakdown(ev)
    assert b["participant1"]["goals"] == 3
    assert b["participant2"]["corners"] == 2


def test_score_breakdown_falls_back_to_score_field():
    ev = _score_update(score={
        "Participant1": {"Goals": 1, "YellowCards": 0, "RedCards": 0, "Corners": 2},
        "Participant2": {"Goals": 0, "YellowCards": 0, "RedCards": 0, "Corners": 1},
    })
    b = score_breakdown(ev)
    assert b["participant1"]["goals"] == 1


def test_score_breakdown_none_when_absent():
    ev = _score_update()
    assert score_breakdown(ev) is None


def test_describe_event_goal_with_type():
    ev = _score_update(action="Goal", dataSoccer={"GoalType": "Head"})
    assert describe_event(ev) == "⚽ GOAL — Header"


def test_describe_event_red_card():
    ev = _score_update(action="RedCard", dataSoccer={"Type": "SecondYellow"})
    assert describe_event(ev) == "🟥 Red Card — Second Yellow"


def test_describe_event_var_end():
    ev = _score_update(action="VAREnd", dataSoccer={"Outcome": "Overturned"})
    assert describe_event(ev) == "📺 VAR Decision — Overturned"


def test_describe_event_shot():
    ev = _score_update(action="Shot", dataSoccer={"Outcome": "OnTarget"})
    assert describe_event(ev) == "🎯 Shot — On Target"


def test_describe_event_generic_fallback():
    ev = _score_update(action="PlayersWarmingUp")
    assert describe_event(ev) == "Players Warming Up"


def test_describe_event_empty_action():
    ev = _score_update(action="")
    assert describe_event(ev) == "Update"
