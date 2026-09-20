"""CLI: txline-watch — live dashboard combining odds and scores streams."""

import asyncio
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

import click
from rich.console import Console
from rich.live import Live
from rich.table import Table

from txline.client import TxLineClient
from txline.models import Fixture, Heartbeat, OddsUpdate, ScoreUpdate
from txline.soccer import describe_event, game_state_label, score_breakdown

console = Console()


@dataclass
class FixtureState:
    fixture_id: int
    name: str
    competition: str = "—"
    kickoff: str = "—"
    score: str = "—"
    game_state: str = "—"
    cards_corners: str = "—"
    last_event: str = "—"
    market: str = "—"
    prices: str = "—"
    pct: str = "—"
    updated: str = ""


def parse_score(event: ScoreUpdate) -> str:
    if event.scoreSoccer:
        h = event.scoreSoccer.get("Home", event.scoreSoccer.get("home", "?"))
        a = event.scoreSoccer.get("Away", event.scoreSoccer.get("away", "?"))
        return f"{h} – {a}"
    if event.score:
        return str(event.score)
    return "—"


def build_table(state: dict[int, FixtureState], flash_fid: int | None = None) -> Table:
    t = Table(title="[bold cyan]TxLINE Live[/bold cyan]", show_lines=True)
    t.add_column("Fixture", style="bold")
    t.add_column("Competition", style="dim")
    t.add_column("Kickoff", style="dim")
    t.add_column("Score", style="bold green")
    t.add_column("State", style="yellow")
    t.add_column("Cards/Corners", style="magenta")
    t.add_column("Last Event", style="bright_white")
    t.add_column("Market", style="dim")
    t.add_column("Prices", style="bright_white")
    t.add_column("Pct", style="cyan")
    t.add_column("Updated", style="dim")
    for fs in sorted(state.values(), key=lambda x: x.fixture_id):
        row_style = "bold" if fs.fixture_id == flash_fid else None
        t.add_row(
            fs.name,
            fs.competition,
            fs.kickoff,
            fs.score,
            fs.game_state,
            fs.cards_corners,
            fs.last_event,
            fs.market,
            fs.prices,
            fs.pct,
            fs.updated,
            style=row_style,
        )
    return t


def apply_event(
    event: OddsUpdate | ScoreUpdate,
    state: dict[int, FixtureState],
    fixtures_cache: dict[int, Fixture],
    now: str,
) -> int:
    fid = event.FixtureId if isinstance(event, OddsUpdate) else event.fixtureId

    if fid not in state:
        state[fid] = FixtureState(fixture_id=fid, name=str(fid), updated=now)

    fs = state[fid]

    if fs.name == str(fid) and fid in fixtures_cache:
        fix = fixtures_cache[fid]
        fs.name = f"{fix.Participant1} vs {fix.Participant2}"
        fs.competition = fix.Competition
        fs.kickoff = datetime.fromtimestamp(fix.StartTime / 1000).strftime("%d %b %H:%M")
        if fs.game_state == "—" and fix.GameState is not None:
            fs.game_state = game_state_label(fix.GameState)

    if isinstance(event, OddsUpdate):
        fs.market = event.SuperOddsType
        if event.Prices:
            if event.PriceNames:
                fs.prices = "  ".join(
                    f"{n}:{p/1000:.3f}" for n, p in zip(event.PriceNames, event.Prices)
                )
            else:
                fs.prices = "  ".join(f"{p/1000:.3f}" for p in event.Prices)
        else:
            fs.prices = "—"
        fs.pct = "  ".join(f"{p}%" for p in event.Pct) if event.Pct else "—"
    else:
        fs.score = parse_score(event)
        fs.game_state = game_state_label(event.gameState)
        fs.last_event = describe_event(event)
        breakdown = score_breakdown(event)
        if breakdown:
            p1, p2 = breakdown["participant1"], breakdown["participant2"]
            fs.cards_corners = (
                f"H 🟨{p1['yellow_cards']} 🟥{p1['red_cards']} 🚩{p1['corners']}  "
                f"A 🟨{p2['yellow_cards']} 🟥{p2['red_cards']} 🚩{p2['corners']}"
            )

    fs.updated = now
    return fid


async def _fetch_fixtures(
    client: TxLineClient,
    cache: dict[int, Fixture],
) -> None:
    try:
        for f in await client.fixtures():
            cache[f.FixtureId] = f
    except Exception:
        pass  # dashboard continues with raw fixture IDs


async def _odds_task(
    client: TxLineClient,
    fixture_id: Optional[int],
    queue: asyncio.Queue,
) -> None:
    async for event in client.odds(fixture_id=fixture_id):
        if not isinstance(event, Heartbeat):
            await queue.put(event)


async def _scores_task(
    client: TxLineClient,
    fixture_id: Optional[int],
    queue: asyncio.Queue,
) -> None:
    async for event in client.scores(fixture_id=fixture_id):
        if not isinstance(event, Heartbeat):
            await queue.put(event)


async def _run(client: TxLineClient, fixture_id: Optional[int]) -> None:
    state: dict[int, FixtureState] = {}
    fixtures_cache: dict[int, Fixture] = {}
    fixtures_fetching = False
    queue: asyncio.Queue[OddsUpdate | ScoreUpdate] = asyncio.Queue()
    _bg_tasks: set = set()

    async def _display_loop() -> None:
        nonlocal fixtures_fetching
        last_fid: int | None = None
        with Live(build_table(state), console=console, refresh_per_second=4) as live:
            while True:
                event = await queue.get()
                now = datetime.now().strftime("%H:%M:%S")
                last_fid = apply_event(event, state, fixtures_cache, now)
                if not fixtures_fetching:
                    fixtures_fetching = True
                    t = asyncio.create_task(_fetch_fixtures(client, fixtures_cache))
                    _bg_tasks.add(t)
                    t.add_done_callback(_bg_tasks.discard)
                live.update(build_table(state, flash_fid=last_fid))

    await asyncio.gather(
        _odds_task(client, fixture_id, queue),
        _scores_task(client, fixture_id, queue),
        _display_loop(),
    )


@click.command()
@click.option("--credentials", default=".txline-credentials.json", show_default=True)
@click.option("--fixture-id", type=int, default=None, help="Filter to a single fixture")
def main(credentials: str, fixture_id: Optional[int]) -> None:
    """Live dashboard combining odds and scores streams."""
    try:
        client = TxLineClient.from_credentials_file(Path(credentials))
    except FileNotFoundError as exc:
        console.print(f"[red]{exc}[/red]")
        raise SystemExit(1)

    async def _go() -> None:
        async with client:
            await _run(client, fixture_id)

    try:
        asyncio.run(_go())
    except KeyboardInterrupt:
        pass
