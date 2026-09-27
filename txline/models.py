from pydantic import BaseModel, ConfigDict, Field
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
    """
    Wire field names are PascalCase, same as OddsUpdate — confirmed against
    live events on 2026-09-27. The aliases below map each to this model's
    existing camelCase attribute names (kept as-is so soccer.py, cli/watch.py,
    api/server.py, and the frontend's JSON contract don't need to change);
    `populate_by_name` lets tests keep constructing instances by attribute
    name directly.
    """

    model_config = ConfigDict(populate_by_name=True)

    fixtureId: int = Field(alias="FixtureId")
    gameState: str = Field(alias="GameState")
    startTime: int = Field(alias="StartTime")
    participant1Id: int = Field(alias="Participant1Id")
    participant2Id: int = Field(alias="Participant2Id")
    competitionId: int = Field(alias="CompetitionId")
    countryId: int = Field(alias="CountryId")
    sportId: int = Field(alias="SportId")
    fixtureGroupId: int = Field(alias="FixtureGroupId")
    isTeam: bool = Field(alias="IsTeam")
    participant1IsHome: bool = Field(alias="Participant1IsHome")
    action: str = Field(alias="Action")
    id: int = Field(alias="Id")
    ts: int = Field(alias="Ts")
    connectionId: int = Field(alias="ConnectionId")
    seq: int = Field(alias="Seq")
    score: Optional[dict] = Field(default=None, alias="Score")
    scoreSoccer: Optional[dict] = Field(default=None, alias="ScoreSoccer")
    scoreBasketball: Optional[dict] = Field(default=None, alias="ScoreBasketball")
    data: Optional[dict] = Field(default=None, alias="Data")
    dataSoccer: Optional[dict] = Field(default=None, alias="DataSoccer")
    dataBasketball: Optional[dict] = Field(default=None, alias="DataBasketball")


class Heartbeat(BaseModel):
    Ts: int


class TokenCredentials(BaseModel):
    jwt: str
    api_token: str
