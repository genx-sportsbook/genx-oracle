"""CLI: txline-stream — tail live odds or scores to stdout."""

import asyncio
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from txline.client import TxLineClient
from txline.models import OddsUpdate, ScoreUpdate, Heartbeat

console = Console()


@click.command()
@click.argument("feed", type=click.Choice(["odds", "scores", "fixtures"]))
@click.option("--credentials", default=".txline-credentials.json", show_default=True)
@click.option("--fixture-id", type=int, default=None, help="Filter to a single fixture")
@click.option("--json-output", is_flag=True, help="Print raw JSON instead of formatted output")
def main(feed, credentials, fixture_id, json_output):
    """Stream live data from TxLINE.\n\nFEED: odds | scores | fixtures"""
    try:
        client = TxLineClient.from_credentials_file(Path(credentials))
    except FileNotFoundError as exc:
        console.print(f"[red]{exc}[/red]")
        raise SystemExit(1)

    asyncio.run(_run(client, feed, fixture_id, json_output))


async def _run(client: TxLineClient, feed: str, fixture_id: int | None, json_output: bool):
    async with client:
        if feed == "fixtures":
            fixtures = await client.fixtures()
            if json_output:
                for f in fixtures:
                    print(f.model_dump_json())
            else:
                t = Table(title="Fixtures", show_lines=True)
                for col in ("FixtureId", "Competition", "Start", "Participants"):
                    t.add_column(col)
                for f in fixtures:
                    t.add_row(
                        str(f.FixtureId),
                        f.Competition,
                        str(f.StartTime),
                        f"{f.Participant1} vs {f.Participant2}",
                    )
                console.print(t)
            return

        stream = client.odds(fixture_id=fixture_id) if feed == "odds" else client.scores(fixture_id=fixture_id)
        console.print(f"[cyan]Streaming {feed}…  (Ctrl-C to stop)[/cyan]")

        async for event in stream:
            if isinstance(event, Heartbeat):
                if not json_output:
                    console.print(f"[dim]♥ {event.Ts}[/dim]")
                continue
            if json_output:
                print(event.model_dump_json())
            else:
                _print_event(event)


def _print_event(event: OddsUpdate | ScoreUpdate):
    if isinstance(event, OddsUpdate):
        console.print(
            f"[bold]{event.Bookmaker}[/bold]  fixture=[yellow]{event.FixtureId}[/yellow]"
            f"  market=[cyan]{event.SuperOddsType}[/cyan]"
            f"  in_running=[green]{event.InRunning}[/green]"
            f"  prices={event.Prices}"
        )
    else:
        console.print(
            f"[bold]SCORE[/bold]  fixture=[yellow]{event.fixtureId}[/yellow]"
            f"  action=[cyan]{event.action}[/cyan]"
            f"  state=[green]{event.gameState}[/green]"
        )
