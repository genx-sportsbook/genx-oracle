"""
Soccer-specific decoding of TxLINE fixture/score data — status codes, score
breakdowns, and human-readable event descriptions.

Field names and enum values below come from TxODDS' "Scores Product API
documentation, Soccer v1.1" PDF (the authoritative spec for this — it isn't
covered by the public txline-docs site at all). TxLINE's own SSE payloads
flatten that PDF's nested Fusion format (`FixtureInfo`/`Update`) into the
single flat object modeled by `ScoreUpdate`, lowercasing the leading letter
of each top-level field (e.g. the PDF's `StatusId` matches `ScoreUpdate.gameState`
1:1 in value). The nested objects (`score`, `scoreSoccer`, `data`) haven't been
observed on a live event yet — no ticketed fixture was in-running while this
was built — so their exact key casing is unconfirmed; `_pick()` below tries
every casing variant defensively instead of assuming one.
"""

import re
from typing import Any, Optional

from txline.models import ScoreUpdate

# Status Id table, PDF p.3-4 ("Status Id"). The same enum has two wire
# representations: Fixture.GameState (numeric, from /fixtures/snapshot) and
# ScoreUpdate.gameState (short code, from live score events).
GAME_STATE_BY_ID: dict[int, str] = {
    1: "Not Started",
    2: "1st Half",
    3: "Half Time",
    4: "2nd Half",
    5: "Finished",
    6: "Waiting for Extra Time",
    7: "Extra Time 1st Half",
    8: "Extra Time Half Time",
    9: "Extra Time 2nd Half",
    10: "Finished (Extra Time)",
    11: "Waiting for Penalties",
    12: "Penalty Shootout",
    13: "Finished (Penalties)",
    14: "Interrupted",
    15: "Abandoned",
    16: "Cancelled",
    17: "Coverage Cancelled",
    18: "Coverage Suspended",
    19: "Postponed",
}

GAME_STATE_BY_CODE: dict[str, str] = {
    "NS": "Not Started",
    "H1": "1st Half",
    "HT": "Half Time",
    "H2": "2nd Half",
    "F": "Finished",
    "WET": "Waiting for Extra Time",
    "ET1": "Extra Time 1st Half",
    "HTET": "Extra Time Half Time",
    "ET2": "Extra Time 2nd Half",
    "FET": "Finished (Extra Time)",
    "WPE": "Waiting for Penalties",
    "PE": "Penalty Shootout",
    "FPE": "Finished (Penalties)",
    "I": "Interrupted",
    "A": "Abandoned",
    "C": "Cancelled",
    "TXCC": "Coverage Cancelled",
    "TXCS": "Coverage Suspended",
    "P": "Postponed",
}

# Phases where the ball is actually in play, for coloring a "LIVE" vs. static
# status badge.
LIVE_STATES = {"1st Half", "2nd Half", "Extra Time 1st Half", "Extra Time 2nd Half", "Penalty Shootout"}


def game_state_label(value: Optional[int] | Optional[str]) -> str:
    """Best-effort label for a Fixture.GameState int or ScoreUpdate.gameState code."""
    if value is None:
        return "—"
    if isinstance(value, int):
        return GAME_STATE_BY_ID.get(value, f"Unknown ({value})")
    return GAME_STATE_BY_CODE.get(value, value)


def is_live_state(label: str) -> bool:
    return label in LIVE_STATES


def _pick(d: Optional[dict], *keys: str) -> Any:
    if not d:
        return None
    for k in keys:
        if k in d:
            return d[k]
    return None


def _period_stats(period_obj: Optional[dict]) -> dict[str, int]:
    """Decode one ScoreParticipantPeriod (PDF p.9): Corners/Goals/RedCards/YellowCards."""
    if not period_obj:
        return {"goals": 0, "yellow_cards": 0, "red_cards": 0, "corners": 0}
    return {
        "goals": _pick(period_obj, "Goals", "goals") or 0,
        "yellow_cards": _pick(period_obj, "YellowCards", "yellowCards") or 0,
        "red_cards": _pick(period_obj, "RedCards", "redCards") or 0,
        "corners": _pick(period_obj, "Corners", "corners") or 0,
    }


def score_breakdown(event: ScoreUpdate) -> Optional[dict]:
    """
    Best-effort decode of the match's aggregate goals/cards/corners so far.

    Prefers `scoreSoccer` (the per-period breakdown), falls back to the
    generic `score` field. Returns None if neither is present — per the PDF,
    score-shaped fields only appear on actions that actually change the
    scoreline, not on every event.
    """
    src = event.scoreSoccer or event.score
    if not src:
        return None
    p1 = _pick(src, "Participant1", "participant1")
    p2 = _pick(src, "Participant2", "participant2")
    if p1 is None and p2 is None:
        return None
    total1 = _pick(p1, "Total", "total") or p1
    total2 = _pick(p2, "Total", "total") or p2
    return {
        "participant1": _period_stats(total1),
        "participant2": _period_stats(total2),
    }


# Enum labels, all confirmed against the PDF's "Amend <X> Action" tables (p.4-6).
_SHOT_OUTCOME_LABELS = {
    "OnTarget": "On Target", "OffTarget": "Off Target",
    "Woodwork": "Woodwork", "Blocked": "Blocked",
}
_FREE_KICK_LABELS = {
    "Safe": "Safe", "Attack": "Attacking", "Danger": "Dangerous",
    "HighDanger": "High Danger", "Offside": "Offside",
}
_RED_CARD_LABELS = {"StraightRed": "Straight Red", "SecondYellow": "Second Yellow"}
_GOAL_TYPE_LABELS = {"Shot": "Shot", "Head": "Header", "Own": "Own Goal", "Other": "Other"}
_PENALTY_OUTCOME_LABELS = {"Scored": "Scored", "Missed": "Missed", "Retake": "Retake"}
_THROW_IN_LABELS = {"Safe": "Safe", "Attack": "Attacking", "Danger": "Dangerous"}
_VAR_OUTCOME_LABELS = {"Stands": "Stands", "Overturned": "Overturned"}


def _prettify_action(action: str) -> str:
    """Fallback for the ~30 other action types the PDF documents (Kickoff,
    Substitution, Lineup, Status, ...) that don't carry a distinctive enum
    worth a bespoke line below."""
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", action)  # "FreeKick" -> "Free Kick"
    return spaced.replace("_", " ").replace("-", " ").title()


def describe_event(event: ScoreUpdate) -> str:
    """One-line, human-readable description of a score-stream event."""
    action = (event.action or "").strip()
    data = event.dataSoccer or event.data or {}
    key = action.lower().replace("_", "").replace(" ", "")

    if key == "goal":
        goal_type = _pick(data, "GoalType", "goalType")
        label = _GOAL_TYPE_LABELS.get(goal_type, goal_type)
        return "⚽ GOAL" + (f" — {label}" if label else "")
    if key == "yellowcard":
        return "🟨 Yellow Card"
    if key == "redcard":
        card_type = _pick(data, "Type", "type")
        label = _RED_CARD_LABELS.get(card_type, card_type)
        return "🟥 Red Card" + (f" — {label}" if label else "")
    if key == "corner":
        return "🚩 Corner"
    if key == "shot":
        outcome = _pick(data, "Outcome", "outcome")
        label = _SHOT_OUTCOME_LABELS.get(outcome, outcome)
        return "🎯 Shot" + (f" — {label}" if label else "")
    if key == "freekick":
        kind = _pick(data, "FreeKickType", "freeKickType")
        label = _FREE_KICK_LABELS.get(kind, kind)
        return "🦵 Free Kick" + (f" — {label}" if label else "")
    if key == "throwin":
        kind = _pick(data, "ThrowInType", "throwInType")
        label = _THROW_IN_LABELS.get(kind, kind)
        return "↩️ Throw In" + (f" — {label}" if label else "")
    if key == "penaltyattempt":
        return "⚠️ Penalty Awarded"
    if key == "penaltyoutcome":
        outcome = _pick(data, "Outcome", "outcome")
        label = _PENALTY_OUTCOME_LABELS.get(outcome, outcome)
        return "🥅 Penalty" + (f" — {label}" if label else "")
    if key == "var":
        return "📺 VAR Review"
    if key == "varend":
        outcome = _pick(data, "Outcome", "outcome")
        label = _VAR_OUTCOME_LABELS.get(outcome, outcome)
        return "📺 VAR Decision" + (f" — {label}" if label else "")
    if key == "substitution":
        return "🔃 Substitution"
    if key == "kickoff":
        return "🏁 Kickoff"
    if key == "halftimefinalised":
        return "⏸️ Half Time"
    if key == "gamefinalised":
        return "🏆 Full Time"
    if key == "injury":
        return "🩹 Injury"
    if key == "suspend":
        return "⏹️ Suspended"
    if key == "standby":
        return "⏳ Standby"
    if not action:
        return "Update"
    return _prettify_action(action)
