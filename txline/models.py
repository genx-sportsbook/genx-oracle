from pydantic import BaseModel, Field
from typing import Optional


class Fixture(BaseModel):
    Ts: int
    StartTime: int
    Competition: str
    CompetitionId: int
    FixtureGroupId: int
    Participant1Id: int
    Participant1: str
    Participant2Id: int
    Participant2: str
    FixtureId: int
    Participant1IsHome: bool
    GameState: Optional[int] = None


class OddsUpdate(BaseModel):
    FixtureId: int
    MessageId: str
    Ts: int
    Bookmaker: str
    BookmakerId: int
    SuperOddsType: str
    InRunning: bool
    GameState: Optional[str] = None
    MarketParameters: Optional[str] = None
    MarketPeriod: Optional[str] = None
    PriceNames: Optional[list[str]] = None
    Prices: Optional[list[int]] = None
    Pct: Optional[list[str]] = None


class ScoreUpdate(BaseModel):
    fixtureId: int
    gameState: str
    startTime: int
    participant1Id: int
    participant2Id: int
    competitionId: int
    countryId: int
    sportId: int
    fixtureGroupId: int
    isTeam: bool
    participant1IsHome: bool
    action: str
    id: str
    ts: int
    connectionId: str
    seq: int
    score: Optional[dict] = None
    scoreSoccer: Optional[dict] = None
    scoreBasketball: Optional[dict] = None
    data: Optional[dict] = None
    dataSoccer: Optional[dict] = None
    dataBasketball: Optional[dict] = None


class Heartbeat(BaseModel):
    Ts: int


class TokenCredentials(BaseModel):
    jwt: str
    api_token: str
