"""
Diagnostic: distinguish "the scores feed is down" from "this fixture just
isn't in TxLINE's scores coverage" (a real, documented distinction — see
txline/soccer.py's GAME_STATE_BY_ID 17/18 "Coverage Cancelled"/"Coverage
Suspended", and https://txline.txodds.com/documentation/scores/schedule,
which lists specific covered leagues like NFL/MLS/Premier League rather than
covering every fixture odds are priced for).

Watches the odds and scores streams concurrently for a window, and for every
fixture the odds stream marks InRunning=True, reports whether the scores
stream produced any events for it.

Usage:
    .venv/bin/python3 scripts/check_scores_coverage.py
    .venv/bin/python3 scripts/check_scores_coverage.py --duration 120
    .venv/bin/python3 scripts/check_scores_coverage.py --fixture-id 18528868
"""

import argparse
import asyncio
import time
from pathlib import Path

from rich.console import Console
from rich.table import Table

from txline.client import TxLineClient
from txline.exceptions import TxLineStreamError
from txline.models import Heartbeat
from txline.soccer import game_state_label

console = Console()


async def watch_odds(credentials: Path, duration: int, fixture_id: int | None) -> dict[int, int]:
    """Returns {fixture_id: odds_event_count} for every fixture seen InRunning=True."""
    live: dict[int, int] = {}
    client = TxLineClient.from_credentials_file(credentials)
    async with client:
        start = time.time()
        async for event in client.odds(fixture_id=fixture_id):
            if not isinstance(event, Heartbeat) and event.InRunning:
                live[event.FixtureId] = live.get(event.FixtureId, 0) + 1
            if time.time() - start > duration:
                break
    return live


async def watch_scores(
    credentials: Path, duration: int, fixture_id: int | None
) -> tuple[dict[int, list[tuple[str, str]]], int]:
    """Returns ({fixture_id: [(action, gameState), ...]}, heartbeat_count)."""
    events: dict[int, list[tuple[str, str]]] = {}
    heartbeats = 0
    client = TxLineClient.from_credentials_file(credentials)
    async with client:
        start = time.time()
        async for event in client.scores(fixture_id=fixture_id):
            if isinstance(event, Heartbeat):
                heartbeats += 1
            else:
                events.setdefault(event.fixtureId, []).append((event.action, event.gameState))
            if time.time() - start > duration:
                break
    return events, heartbeats


async def resolve_names(credentials: Path, fixture_ids: set[int]) -> dict[int, str]:
    client = TxLineClient.from_credentials_file(credentials)
    async with client:
        fixtures = await client.fixtures()
    return {
        f.FixtureId: f"{f.Competition}: {f.Participant1} vs {f.Participant2}"
        for f in fixtures
        if f.FixtureId in fixture_ids
    }


async def main(credentials: Path, duration: int, fixture_id: int | None):
    console.print(
        f"[cyan]Watching odds + scores for {duration}s"
        + (f" (fixture {fixture_id})" if fixture_id else " (all live fixtures)")
        + "…[/cyan]"
    )
    try:
        live_fixtures, (scores_events, heartbeats) = await asyncio.gather(
            watch_odds(credentials, duration, fixture_id),
            watch_scores(credentials, duration, fixture_id),
        )
    except TxLineStreamError as exc:
        console.print(f"[bold red]{exc}[/bold red]")
        return

    if heartbeats == 0:
        console.print(
            "[bold red]No heartbeats received on the scores stream at all — "
            "the connection itself looks down, not a coverage gap.[/bold red]"
        )

    if not live_fixtures:
        console.print(
            "[yellow]No fixtures were seen InRunning=True on the odds stream during this "
            "window — nothing live to check coverage for right now. Try again during "
            "known kickoff times, or re-run with --duration higher / --fixture-id set "
            "to a specific match.[/yellow]"
        )
        if scores_events:
            console.print(
                f"[dim](scores stream did report events for fixtures not currently "
                f"InRunning per odds: {sorted(scores_events)})[/dim]"
            )
        return

    names = await resolve_names(credentials, set(live_fixtures) | set(scores_events))

    table = Table(title="Scores coverage for live fixtures", show_lines=True)
    for col in ("FixtureId", "Fixture", "Odds events", "Score events", "Last state", "Coverage"):
        table.add_column(col)

    for fid, odds_count in sorted(live_fixtures.items(), key=lambda kv: -kv[1]):
        fixture_events = scores_events.get(fid, [])
        if fixture_events:
            last_action, last_state = fixture_events[-1]
            state_label = game_state_label(last_state)
            if state_label in ("Coverage Cancelled", "Coverage Suspended"):
                verdict = f"[yellow]NOT COVERED — {state_label}[/yellow]"
            else:
                verdict = "[green]COVERED[/green]"
        else:
            state_label = "—"
            verdict = "[yellow]NOT COVERED — no score events[/yellow]"

        table.add_row(
            str(fid),
            names.get(fid, "(name unresolved)"),
            str(odds_count),
            str(len(fixture_events)),
            state_label,
            verdict,
        )

    console.print(table)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--credentials", default=".txline-credentials.json", type=Path)
    parser.add_argument("--duration", default=60, type=int, help="Seconds to watch (default: 60)")
    parser.add_argument("--fixture-id", default=None, type=int, help="Limit to one fixture")
    args = parser.parse_args()

    asyncio.run(main(args.credentials, args.duration, args.fixture_id))
