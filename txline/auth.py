"""
Authentication against the TxLINE API.

Two-phase flow:
  1. Guest JWT  — anonymous, short-lived, no credentials needed.
  2. API token  — long-lived, requires a prior on-chain subscription and a
                  NaCl-signed activation request.
"""

import base64
import json
import logging
from pathlib import Path

import httpx
import nacl.signing
import nacl.encoding

from txline.models import TokenCredentials

logger = logging.getLogger(__name__)

BASE_URL = "https://txline.txodds.com"


async def get_guest_jwt(client: httpx.AsyncClient) -> str:
    resp = await client.post(f"{BASE_URL}/auth/guest/start")
    resp.raise_for_status()
    return resp.json()["token"]


def build_activation_message(tx_sig: str, leagues: list[int], jwt: str) -> bytes:
    """
    Server expects the exact string  "{txSig}:{leagues.join(',')}:{jwt}"
    signed with the wallet's Ed25519 key using NaCl detached signature.
    An empty leagues list joins to an empty string, e.g. "{txSig}::{jwt}".
    """
    leagues_str = ",".join(str(league) for league in leagues)
    msg = f"{tx_sig}:{leagues_str}:{jwt}"
    return msg.encode()


def sign_message(secret_key_bytes: bytes, message: bytes) -> str:
    """Sign message with Ed25519 key; return base64-encoded detached signature."""
    signing_key = nacl.signing.SigningKey(secret_key_bytes)
    signed = signing_key.sign(message)
    # nacl returns prefix+message; detached signature is first 64 bytes
    signature = signed.signature
    return base64.b64encode(signature).decode()


async def activate_token(
    client: httpx.AsyncClient,
    jwt: str,
    tx_sig: str,
    wallet_signature_b64: str,
    leagues: list[int],
) -> str:
    """POST activation request; returns long-lived apiToken."""
    resp = await client.post(
        f"{BASE_URL}/api/token/activate",
        headers={"Authorization": f"Bearer {jwt}"},
        json={
            "txSig": tx_sig,
            "walletSignature": wallet_signature_b64,
            "leagues": leagues,
        },
    )
    resp.raise_for_status()
    # The server returns the API token as a bare text/plain body, not JSON.
    return resp.text.strip()


def load_credentials(path: Path) -> TokenCredentials | None:
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    return TokenCredentials(**data)


def save_credentials(creds: TokenCredentials, path: Path) -> None:
    path.write_text(creds.model_dump_json(indent=2))
    logger.info("Credentials saved to %s", path)
