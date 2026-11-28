"""Shared SQLite storage for the TxLINE ingester and dashboard."""

import json
import sqlite3
import time
from collections import defaultdict
from contextlib import closing
from hashlib import sha256
from pathlib import Path
from uuid import uuid4

from txline.models import Fixture, OddsUpdate, ScoreUpdate

DEFAULT_DATABASE = Path("txline.sqlite3")
FIXTURES_CACHE_TTL = 300
REPLAY_LIMIT = 50
ENGLISH_PREMIER_LEAGUE_ID = 8
MATCH_ODDS_TYPE = "1X2_PARTICIPANT_RESULT"

FIXTURE_FIELDS = (
    "FixtureId", "Participant1", "Participant2", "Participant1IsHome", "Competition", "StartTime",
    "GameState",
)


INSERT_EVENT = """
    INSERT OR IGNORE INTO events (feed, fixture_id, market, event_key, has_value, payload)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM fixtures WHERE id = ?)
"""


def odds_market(event: OddsUpdate) -> str:
    period = event.MarketPeriod or ""
    return json.dumps([event.SuperOddsType, event.MarketParameters or "",
                       "" if period == "fulltime" else period])


def event_values(
    event: OddsUpdate | ScoreUpdate, feed: str, fixture_id: int, market: str,
    key: str, has_value: bool, *, archived: bool = False,
) -> tuple[str, int, str, str, bool, str, int]:
    payload = event.model_dump()
    payload["receivedAt"] = int(time.time() * 1000)
    if archived:
        payload["archived"] = True
    return (
        feed, fixture_id, market, key, has_value,
        json.dumps(payload, separators=(",", ":")), fixture_id,
    )


class FeedStore:
    def __init__(self, path: Path):
        self.path = path

    def _connect(self, *, read_only: bool = False) -> sqlite3.Connection:
        if read_only:
            return sqlite3.connect(f"{self.path.resolve().as_uri()}?mode=ro", uri=True)
        return sqlite3.connect(self.path)

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db, db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                BEGIN;
                CREATE TABLE IF NOT EXISTS metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS snapshot (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    updated REAL NOT NULL,
                    body BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS fixtures (id INTEGER PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    feed TEXT NOT NULL,
                    fixture_id INTEGER NOT NULL,
                    market TEXT NOT NULL,
                    event_key TEXT NOT NULL,
                    has_value INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    UNIQUE (feed, fixture_id, event_key)
                );
                CREATE INDEX IF NOT EXISTS events_feed_id ON events (feed, id);
                CREATE INDEX IF NOT EXISTS events_feed_fixture_id ON events (feed, fixture_id, id);
                CREATE TABLE IF NOT EXISTS feeds (
                    name TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    updated REAL NOT NULL
                );
            """)
            db.execute(
                "INSERT OR IGNORE INTO metadata VALUES ('epoch', ?)", (uuid4().hex,),
            )

    def replace_fixtures(self, fixtures: list[Fixture]) -> frozenset[int]:
        fixtures = [f for f in fixtures if f.CompetitionId == ENGLISH_PREMIER_LEAGUE_ID]
        ids = frozenset(f.FixtureId for f in fixtures)
        body = json.dumps(
            [{key: getattr(f, key) for key in FIXTURE_FIELDS} for f in fixtures],
            separators=(",", ":"),
        ).encode()
        with closing(self._connect()) as db, db:
            db.execute("DELETE FROM fixtures")
            db.executemany("INSERT INTO fixtures VALUES (?)", ((fid,) for fid in ids))
            db.execute("REPLACE INTO snapshot VALUES (1, ?, ?)", (time.time(), body))
            db.execute("DELETE FROM events WHERE fixture_id NOT IN (SELECT id FROM fixtures)")
            self._trim_history(db)
        return ids

    def trim_history(self) -> None:
        with closing(self._connect()) as db, db:
            self._trim_history(db)

    @staticmethod
    def _trim_history(db: sqlite3.Connection) -> None:
        # Preserve the latest quote or scoreline through updates without values.
        db.execute("""
            DELETE FROM events WHERE id IN (
                SELECT id FROM (
                    SELECT id,
                        row_number() OVER (
                            PARTITION BY feed, fixture_id, market
                            ORDER BY CASE WHEN feed = 'odds' THEN json_extract(payload, '$.Ts') END DESC,
                                id DESC
                        ) AS history_rank,
                        first_value(id) OVER (
                            PARTITION BY feed, fixture_id, market
                            ORDER BY has_value DESC,
                                CASE WHEN feed = 'odds' THEN json_extract(payload, '$.Ts') END DESC,
                                id DESC
                        ) AS latest_value
                    FROM events
                ) WHERE history_rank > ? AND id != latest_value
            )
        """, (REPLAY_LIMIT,))

    def fixture_ids(self) -> frozenset[int]:
        with closing(self._connect(read_only=True)) as db:
            return frozenset(row[0] for row in db.execute("SELECT id FROM fixtures"))

    def snapshot(self) -> tuple[float, bytes] | None:
        if not self.path.is_file():
            return None
        with closing(self._connect(read_only=True)) as db:
            return db.execute("SELECT updated, body FROM snapshot WHERE id = 1").fetchone()

    def append(self, event: OddsUpdate | ScoreUpdate) -> None:
        if isinstance(event, OddsUpdate):
            if event.SuperOddsType != MATCH_ODDS_TYPE:
                return
            market = odds_market(event)
            feed, fid, key, has_value = "odds", event.FixtureId, event.MessageId, bool(event.Prices)
        else:
            if event.competitionId != ENGLISH_PREMIER_LEAGUE_ID:
                return
            feed, fid = "scores", event.fixtureId
            market, has_value = "", bool(event.scoreSoccer or event.score)
            # Transport sequence numbers change on reconnect. Preserve changed event data.
            content = event.model_dump_json(exclude={"connectionId", "seq"})
            key = sha256(content.encode()).hexdigest()
        with closing(self._connect()) as db, db:
            db.execute(INSERT_EVENT, event_values(event, feed, fid, market, key, has_value))

    def append_odds_history(self, fixture_id: int, events: list[OddsUpdate]) -> int:
        markets: dict[str, list[OddsUpdate]] = defaultdict(list)
        for event in events:
            if event.FixtureId == fixture_id and event.SuperOddsType == MATCH_ODDS_TYPE:
                markets[odds_market(event)].append(event)

        rows: list[tuple[OddsUpdate, str]] = []
        for market, history in markets.items():
            history.sort(key=lambda event: event.Ts)
            recent = history[-REPLAY_LIMIT:]
            if not any(event.Prices for event in recent):
                last_quote = next((event for event in reversed(history) if event.Prices), None)
                if last_quote is not None:
                    recent.insert(0, last_quote)
            rows.extend((event, market) for event in recent)
        rows.sort(key=lambda row: row[0].Ts)
        if not rows:
            return 0

        with closing(self._connect()) as db, db:
            db.executemany(INSERT_EVENT, (
                event_values(event, "odds", fixture_id, market, event.MessageId,
                             bool(event.Prices), archived=True)
                for event, market in rows
            ))
            inserted = db.total_changes
            self._trim_history(db)
        return inserted

    def set_feed_status(self, feed: str, status: str) -> None:
        with closing(self._connect()) as db, db:
            db.execute("REPLACE INTO feeds VALUES (?, ?, ?)", (feed, status, time.time()))

    def read_feed(
        self, feed: str, fixture_id: int | None, cursor: tuple[str, int] | None,
    ) -> tuple[str, list[tuple[int, str]], tuple[str, float] | None]:
        if not self.path.is_file():
            return "", [], None
        with closing(self._connect(read_only=True)) as db:
            db.execute("BEGIN")
            epoch_row = db.execute("SELECT value FROM metadata WHERE key = 'epoch'").fetchone()
            if epoch_row is None:
                return "", [], None
            epoch = epoch_row[0]
            after = cursor[1] if cursor is not None and cursor[0] == epoch else 0
            sql = "SELECT id, payload FROM events WHERE feed = ? AND id > ?"
            params = [feed, after]
            if fixture_id is not None:
                sql += " AND fixture_id = ?"
                params.append(fixture_id)
            rows = db.execute(sql + " ORDER BY id LIMIT 250", params).fetchall()
            status = db.execute(
                "SELECT status, updated FROM feeds WHERE name = ?", (feed,),
            ).fetchone()
            return epoch, rows, status
