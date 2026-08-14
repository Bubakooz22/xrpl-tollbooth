"""XRPL Toll Booth — LangChain Python tools.

Copy-paste-ready. Each of the seven tollbooth endpoints is exposed as a
LangChain @tool. The tools auto-discover pricing and auth mode from the
tollbooth's /.well-known/agent.json at import time.

Usage:

    from tollbooth_tools import build_tollbooth_tools
    from langchain.agents import initialize_agent, AgentType
    from langchain_openai import ChatOpenAI

    tools = build_tollbooth_tools()  # picks up TOLLBOOTH_URL, TOLLBOOTH_API_KEY
    agent = initialize_agent(
        tools,
        ChatOpenAI(model="gpt-4o"),
        agent=AgentType.OPENAI_FUNCTIONS,
        verbose=True,
    )
    agent.invoke("Is 0xdac17f958d2ee523a2206206994597c13d831ec7 a known-exploit contract?")

Environment:
    TOLLBOOTH_URL       default http://127.0.0.1:8787
    TOLLBOOTH_API_KEY   required for verify-poc + auth-ping
    XRPL_SEED           required for x402 endpoints (payer seed)

The x402 tools shell out to `scripts/paid-call.mjs` (Node) at the repo root,
so this file assumes it's imported from inside the xrpl-tollbooth checkout,
or that PAID_CALL_SCRIPT_PATH points at the script.

Dependencies:
    pip install langchain langchain-core requests
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any

import requests
from langchain_core.tools import StructuredTool, tool

TOLLBOOTH_URL = os.environ.get("TOLLBOOTH_URL", "http://127.0.0.1:8787")
TOLLBOOTH_API_KEY = os.environ.get("TOLLBOOTH_API_KEY", "")
PAID_CALL_SCRIPT = os.environ.get(
    "PAID_CALL_SCRIPT_PATH",
    str(Path(__file__).resolve().parents[3] / "scripts" / "paid-call.mjs"),
)
REPO_ROOT = Path(PAID_CALL_SCRIPT).resolve().parents[1]


# ---------------------------------------------------------------------------
# Low-level transport
# ---------------------------------------------------------------------------

def _load_manifest() -> dict:
    """Fetch /.well-known/agent.json once per import so the tools stay in sync."""
    r = requests.get(f"{TOLLBOOTH_URL}/.well-known/agent.json", timeout=5)
    r.raise_for_status()
    return r.json()


def _call_bearer(path: str, method: str, body: dict | None = None) -> dict:
    if not TOLLBOOTH_API_KEY:
        raise RuntimeError(
            "TOLLBOOTH_API_KEY not set. This endpoint is in closed beta; "
            "open a GitHub issue on xrpl-tollbooth to request a key."
        )
    headers = {"Authorization": f"Bearer {TOLLBOOTH_API_KEY}"}
    r = requests.request(
        method,
        f"{TOLLBOOTH_URL}{path}",
        headers=headers,
        json=body,
        timeout=180,
    )
    try:
        return r.json()
    except ValueError:
        return {"status": r.status_code, "text": r.text}


def _call_x402(path: str, body: dict) -> dict:
    """Shell out to scripts/paid-call.mjs so the LangChain tool inherits
    the same x402 flow the smoke tests use."""
    if not os.environ.get("XRPL_SEED"):
        raise RuntimeError(
            "XRPL_SEED not set. x402 endpoints need a payer seed. "
            "Add it to .env or export it before running."
        )
    result = subprocess.run(
        [
            "node",
            f"--env-file={REPO_ROOT / '.env'}",
            PAID_CALL_SCRIPT,
            path,
            json.dumps(body),
        ],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        env={**os.environ, "TOLLBOOTH_URL": TOLLBOOTH_URL},
        timeout=180,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"paid-call.mjs exited {result.returncode}\n"
            f"stderr: {result.stderr}\nstdout: {result.stdout}"
        )
    stdout = result.stdout
    idx = stdout.rfind("{")
    if idx == -1:
        return {"raw": stdout}
    try:
        return json.loads(stdout[idx:])
    except json.JSONDecodeError:
        return {"raw": stdout}


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

@tool
def wallet_risk(chain: str, address: str) -> dict:
    """Score a wallet address for OFAC + curated scam-list membership.

    Costs 1000 drops XRP (~$0.0005) per call, settled on-chain via x402.
    Supports chain values 'eth', 'xrpl', 'sol'. Returns a dict with
    risk_level ('low'|'medium'|'high'|'critical'), score, reason_codes[],
    sources_checked[]. Reason codes: OFAC_SANCTIONED, SCAM_LIST_HIT,
    UNKNOWN_ADDRESS. Refuse to interact if risk_level is 'critical'.
    """
    return _call_x402("/wallet-risk", {"chain": chain, "address": address})


@tool
def contract_risk(chain: str, address: str) -> dict:
    """Score a smart-contract address for known-exploit database matches
    and source-code heuristics.

    Costs 1000 drops XRP per call via x402. Chain 'eth' only today.
    Returns risk_level, reason_codes[], and known_exploit_match{name,url}
    when the address is in the curated exploit database. Codes:
    KNOWN_EXPLOIT_MATCH (refuse), SELFDESTRUCT_PRESENT, DELEGATECALL_PRESENT,
    PROXY_UPGRADEABLE, SOURCE_UNVERIFIED (warn).
    """
    return _call_x402("/contract-risk", {"chain": chain, "address": address})


@tool
def tx_simulate_risk(
    chain: str,
    from_addr: str,
    to: str,
    data: str = "",
    value: str = "0",
) -> dict:
    """Simulate an Ethereum transaction on a mainnet fork and grade the outcome.

    Costs 1000 drops XRP per call via x402. Detects unlimited ERC-20 approvals,
    ownership transfer, proxy upgrade, selfdestruct, reverts, and multi-token
    outbound flows. Chain 'eth' only. `data` is hex calldata (with or without
    0x). `value` is wei as a decimal string.

    Codes (in severity order): SELFDESTRUCT_INVOKED, UNLIMITED_APPROVAL_GRANTED,
    OWNERSHIP_TRANSFERRED, PROXY_UPGRADED (hard warn); TX_REVERTED,
    MULTIPLE_OUTBOUND_TOKEN_TRANSFERS (inform).
    """
    return _call_x402(
        "/tx-simulate-risk",
        {"chain": chain, "from": from_addr, "to": to, "data": data, "value": value},
    )


@tool
def scope_check(address: str, chain: str = "eth") -> dict:
    """Check whether an address is in scope of any active bug bounty program.

    Costs 1000 drops XRP per call via x402. Returns in_scope (bool) plus
    programs[] with platform, name, url, max_bounty. Current coverage:
    15 programs, 109 contracts, refreshed daily. Absence of a match is
    not proof — the target may just not be tracked.
    """
    return _call_x402("/scope-check", {"address": address, "chain": chain})


@tool
def verify_poc(
    test_file_base64: str,
    expected_result: str = "pass",
    fork_block: int | None = None,
) -> dict:
    """Grade a Foundry PoC (.t.sol) against an Ethereum mainnet fork.

    Closed beta — requires TOLLBOOTH_API_KEY. Rate limit: 10/min per key.
    Runs forge test --fork-url --json in an ephemeral sandbox with ffi=false
    pinned. Single-file only, max 128 KB decoded. Chain 'eth' only.

    `test_file_base64` is the .t.sol source base64-encoded.
    `expected_result` is 'pass' or 'revert'. `fork_block` pins the fork
    to a specific block (latest if omitted).

    Returns verified (bool), reason_codes[], actual, gas_used, logs[],
    traces_head, duration_ms. Codes distinguish grading (POC_VERIFIED,
    POC_UNVERIFIED) from user error (COMPILE_ERROR, PARSE_FAILURE) from
    sandbox policy (FFI_DISALLOWED) from infra (RPC_UNREACHABLE, TIMEOUT).
    """
    body: dict[str, Any] = {
        "test_file": test_file_base64,
        "expected_result": expected_result,
    }
    if fork_block is not None:
        body["fork_block"] = fork_block
    return _call_bearer("/verify-poc", "POST", body)


@tool
def auth_ping() -> dict:
    """Verify the tollbooth API key is working. No side effects, no charge.

    Returns {ok: true, key: {id, name, prefix}, rate_limit: {per_minute}}.
    Use this to sanity-check TOLLBOOTH_API_KEY before hitting verify-poc.
    """
    return _call_bearer("/auth-ping", "GET")


# ---------------------------------------------------------------------------
# Public builder
# ---------------------------------------------------------------------------

def build_tollbooth_tools(include_beta: bool = True) -> list:
    """Return the list of LangChain tools for the tollbooth.

    include_beta=False drops the API-key-gated endpoints (verify_poc,
    auth_ping) if you only want the x402-payable surface.
    """
    tools = [wallet_risk, contract_risk, tx_simulate_risk, scope_check]
    if include_beta:
        tools.extend([verify_poc, auth_ping])
    return tools


if __name__ == "__main__":
    # Smoke: fetch manifest and list tools.
    m = _load_manifest()
    print(f"Tollbooth: {m['display_name']} v{m['version']}")
    print(f"Endpoints in manifest: {len(m['endpoints'])}")
    print(f"LangChain tools exposed: {len(build_tollbooth_tools())}")
    for t in build_tollbooth_tools():
        print(f"  - {t.name}: {t.description.splitlines()[0]}")
