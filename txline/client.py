"""High-level TxLineClient — entry point for application code."""

from collections.abc import AsyncIterator
from pathlib import Path
from typing import Optional

import httpx

from txline.auth import load_credentials, save_credentials
from txline.models import Fixture, OddsUpdate, ScoreUpdate, Heartbeat, TokenCredentials
from txline.rest.fixtures import get_fixtures, get_fixtures_window
from txline.streams.odds import stream_odds
from txline.streams.scores import stream_scores

DEFAULT_CREDS_PATH = Path(".txline-credentials.json")


class TxLineClient:
    """
    Facade over the TxLINE API.

    Usage:
        async with TxLineClient.from_credentials_file() as c:
            fixtures = await c.fixtures()
            async for event in c.odds():
                print(event)
    """

    def __init__(self, jwt: str, api_token: str):
        self._jwt = jwt
        self._api_token = api_token
        self._http = httpx.AsyncClient()

    @classmethod
    def from_credentials(cls, creds: TokenCredentials) -> "TxLineClient":
        return cls(jwt=creds.jwt, api_token=creds.api_token)

    @classmethod
    def from_credentials_file(cls, path: Path = DEFAULT_CREDS_PATH) -> "TxLineClient":
        creds = load_credentials(path)
        if creds is None:
            raise FileNotFoundError(
                f"No credentials found at {path}. Run `txline-subscribe` first."
            )
        return cls.from_credentials(creds)

    async def __aenter__(self) -> "TxLineClient":
        return self

    async def __aexit__(self, *_) -> None:
        await self._http.aclose()

    async def fixtures(
        self,
        start_epoch_day: Optional[int] = None,
        competition_id: Optional[int] = None,
    ) -> list[Fixture]:
        # An explicit day gets exactly that day's bucket; the common "just
        # give me the fixtures" call spans yesterday+today by default so a
        # still-live match doesn't lose its name once its bucket rolls over
        # — see get_fixtures_window's docstring.
        if start_epoch_day is not None:
            return await get_fixtures(
                self._http,
                self._jwt,
                self._api_token,
                start_epoch_day=start_epoch_day,
                competition_id=competition_id,
            )
        return await get_fixtures_window(
            self._http,
            self._jwt,
            self._api_token,
            competition_id=competition_id,
        )

    def odds(
        self,
        fixture_id: Optional[int] = None,
        last_event_id: Optional[str] = None,
    ) -> AsyncIterator[OddsUpdate | Heartbeat]:
        return stream_odds(
            self._jwt,
            self._api_token,
            fixture_id=fixture_id,
            last_event_id=last_event_id,
        )

    def scores(
        self,
        fixture_id: Optional[int] = None,
        last_event_id: Optional[str] = None,
    ) -> AsyncIterator[ScoreUpdate | Heartbeat]:
        return stream_scores(
            self._jwt,
            self._api_token,
            fixture_id=fixture_id,
            last_event_id=last_event_id,
        )
