"""
On-chain subscription flow for the TxLINE free tier.

Submits a zero-cost transaction to the TxLINE Solana program to activate
a subscription, then exchanges the resulting tx signature + wallet proof
for a long-lived API token.

Program:  9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA
TxL mint: Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL
"""

import hashlib
import logging
from pathlib import Path

import httpx
from solders.keypair import Keypair
from solders.pubkey import Pubkey

from txline.auth import (
    get_guest_jwt,
    build_activation_message,
    sign_message,
    activate_token,
    save_credentials,
)
from txline.models import TokenCredentials

logger = logging.getLogger(__name__)

PROGRAM_ID = Pubkey.from_string("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA")
TXL_MINT = Pubkey.from_string("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL")
SOLANA_RPC = "https://api.mainnet-beta.solana.com"

# Free-tier service levels:  1 = 60-second delay,  12 = real-time
SERVICE_LEVEL_FREE_DELAYED = 1
SERVICE_LEVEL_FREE_REALTIME = 12
MIN_DURATION_WEEKS = 4

# Empty list = use the bundled league package for the chosen service level
FREE_TIER_LEAGUES: list[int] = []


async def subscribe_free_tier(
    keypair: Keypair,
    service_level: int = SERVICE_LEVEL_FREE_REALTIME,
    duration_weeks: int = MIN_DURATION_WEEKS,
    rpc_url: str = SOLANA_RPC,
    save_path: Path = Path(".txline-credentials.json"),
) -> TokenCredentials:
    """
    Full subscription + activation flow for the free tier.

    1. Get guest JWT.
    2. Build and send the on-chain subscribe transaction.
    3. Sign the activation message with the wallet key.
    4. Exchange for a long-lived API token.
    5. Persist credentials to disk.
    """
    # The server independently re-validates the on-chain tx before activating,
    # which can take longer than httpx's default 5s timeout.
    async with httpx.AsyncClient(timeout=60.0) as http_client:
        logger.info("Fetching guest JWT…")
        jwt = await get_guest_jwt(http_client)

        logger.info(
            "Submitting on-chain subscription (level=%d, weeks=%d)…",
            service_level,
            duration_weeks,
        )
        tx_sig = await _submit_subscription(keypair, service_level, duration_weeks, rpc_url)
        logger.info("On-chain tx confirmed: %s", tx_sig)

        message = build_activation_message(tx_sig, FREE_TIER_LEAGUES, jwt)
        wallet_sig_b64 = sign_message(bytes(keypair.secret()), message)

        logger.info("Activating API token…")
        api_token = await activate_token(
            http_client, jwt, tx_sig, wallet_sig_b64, FREE_TIER_LEAGUES
        )

    creds = TokenCredentials(jwt=jwt, api_token=api_token)
    save_credentials(creds, save_path)
    return creds


# anchorpy's Idl parser (as of 0.21.0, the latest release) cannot parse the
# modern Anchor IDL format this program publishes ("data did not match any
# variant of untagged enum IdlAccountItem"), so the subscribe instruction is
# hand-built here instead of going through anchorpy's Program/Idl machinery.
# The account list and PDA seeds below come from the deployed program source
# (programs/txoracle/src/instructions/subscriptions/subscribe.rs).

SYSTEM_PROGRAM_ID = Pubkey.from_string("11111111111111111111111111111111")
TOKEN_2022_PROGRAM_ID = Pubkey.from_string("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
ASSOCIATED_TOKEN_PROGRAM_ID = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")

# Anchor instruction discriminator: first 8 bytes of sha256("global:subscribe")
_SUBSCRIBE_DISCRIMINATOR = hashlib.sha256(b"global:subscribe").digest()[:8]


async def _submit_subscription(
    keypair: Keypair,
    service_level: int,
    duration_weeks: int,
    rpc_url: str,
) -> str:
    """Build and send the subscribe transaction; return the confirmed tx signature."""
    from solana.rpc.async_api import AsyncClient
    from solana.rpc.commitment import Confirmed
    from solders.instruction import AccountMeta, Instruction
    from solders.transaction import Transaction

    user = keypair.pubkey()
    user_ata = _derive_ata(user, TXL_MINT)

    pricing_matrix, _ = Pubkey.find_program_address([b"pricing_matrix"], PROGRAM_ID)
    treasury_pda, _ = Pubkey.find_program_address([b"token_treasury_v2"], PROGRAM_ID)
    treasury_vault = _derive_ata(treasury_pda, TXL_MINT)

    data = (
        _SUBSCRIBE_DISCRIMINATOR
        + service_level.to_bytes(2, "little")
        + duration_weeks.to_bytes(1, "little")
    )
    accounts = [
        AccountMeta(pubkey=user, is_signer=True, is_writable=True),
        AccountMeta(pubkey=pricing_matrix, is_signer=False, is_writable=False),
        AccountMeta(pubkey=TXL_MINT, is_signer=False, is_writable=False),
        AccountMeta(pubkey=user_ata, is_signer=False, is_writable=True),
        AccountMeta(pubkey=treasury_vault, is_signer=False, is_writable=True),
        AccountMeta(pubkey=treasury_pda, is_signer=False, is_writable=False),
        AccountMeta(pubkey=TOKEN_2022_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(pubkey=SYSTEM_PROGRAM_ID, is_signer=False, is_writable=False),
        AccountMeta(pubkey=ASSOCIATED_TOKEN_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    instruction = Instruction(PROGRAM_ID, data, accounts)

    async with AsyncClient(rpc_url) as connection:
        blockhash_resp = await connection.get_latest_blockhash()
        tx = Transaction.new_signed_with_payer(
            [instruction],
            user,
            [keypair],
            blockhash_resp.value.blockhash,
        )
        send_resp = await connection.send_transaction(tx)
        tx_sig = send_resp.value
        await connection.confirm_transaction(tx_sig, commitment=Confirmed)

    return str(tx_sig)


def _derive_ata(owner: Pubkey, mint: Pubkey) -> Pubkey:
    """Derive the Token-2022 Associated Token Account PDA for (owner, mint)."""
    seeds = [bytes(owner), bytes(TOKEN_2022_PROGRAM_ID), bytes(mint)]
    return Pubkey.find_program_address(seeds, ASSOCIATED_TOKEN_PROGRAM_ID)[0]
