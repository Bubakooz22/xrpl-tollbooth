#!/usr/bin/env bash
# XRPL Toll Booth — Aquarium Cohort 9 demo script
# Usage: ./demo.sh [handshake|paid-clean|paid-sanctioned|full]

set -e

# Colors for terminal output
BOLD='\033[1m'
GREEN='\033[32m'
CYAN='\033[36m'
YELLOW='\033[33m'
RED='\033[31m'
DIM='\033[2m'
RESET='\033[0m'

API="https://api.txnguardian.com"
CLEAN_ADDR="rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
OFAC_ADDR="rnXyVQzgxZe7TR1EPzTkGj2jxH4LMJYh66"

banner() {
  echo ""
  echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}${CYAN}  $1${RESET}"
  echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════${RESET}"
  echo ""
}

wait_beat() { sleep 1; }

check_balance() {
  local addr=$1
  local label=$2
  BAL=$(curl -sS -X POST https://xrplcluster.com/ \
    -H "Content-Type: application/json" \
    -d "{\"method\":\"account_info\",\"params\":[{\"account\":\"$addr\"}]}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); b=d.get('result',{}).get('account_data',{}).get('Balance','0'); print(f'{int(b)/1_000_000:.6f}')" 2>/dev/null || echo "?")
  echo -e "${DIM}  $label ($addr): ${BAL} XRP${RESET}"
}

cmd_handshake() {
  banner "1️⃣  The 402 handshake — unpaid probe reveals payment requirements"
  echo -e "${BOLD}\$ curl -sS -X POST $API/wallet-risk \\\\"
  echo -e "    -H 'Content-Type: application/json' \\\\"
  echo -e "    -d '{\"address\":\"$CLEAN_ADDR\",\"chain\":\"xrpl\"}'${RESET}"
  echo ""
  wait_beat

  RESP=$(curl -sS -w "\n___STATUS___%{http_code}" -X POST "$API/wallet-risk" \
    -H "Content-Type: application/json" \
    -d "{\"address\":\"$CLEAN_ADDR\",\"chain\":\"xrpl\"}")
  STATUS=$(echo "$RESP" | tail -1 | sed 's/___STATUS___//')
  BODY=$(echo "$RESP" | sed '$d')

  echo -e "${BOLD}${YELLOW}HTTP $STATUS${RESET}"
  echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
  echo ""
  echo -e "${GREEN}✓${RESET} Agent now knows: pay 5000 drops XRP (or 0.002 RLUSD) on ${BOLD}xrpl:0${RESET} mainnet"
  echo -e "${GREEN}✓${RESET} Facilitator verifies settlement, then the API executes"
}

cmd_paid_clean() {
  banner "2️⃣  Paid call — clean address (baseline happy path)"
  check_balance "raM5UMifT2mBfuE3CwERSHc9u2AsBEdUQp" "buyer   "
  check_balance "rK1C1DPzJo9gSjK2LSdhV5J5veFB84zHer" "merchant"
  echo ""
  echo -e "${BOLD}\$ TARGET_PATH=/wallet-risk REQUEST_BODY='{\"address\":\"$CLEAN_ADDR\",\"chain\":\"xrpl\"}' \\\\"
  echo -e "    node --env-file=buyer.env.mainnet pay-and-fetch.mjs${RESET}"
  echo ""
  wait_beat

  TARGET_PATH=/wallet-risk \
  REQUEST_BODY="{\"address\":\"$CLEAN_ADDR\",\"chain\":\"xrpl\"}" \
  node --env-file=buyer.env.mainnet pay-and-fetch.mjs
}

cmd_paid_sanctioned() {
  banner "3️⃣  Paid call — OFAC-sanctioned address (the money shot)"
  echo -e "${DIM}Address $OFAC_ADDR is on the OFAC SDN list — verifiable at${RESET}"
  echo -e "${DIM}  https://xrpscan.com/account/$OFAC_ADDR${RESET}"
  echo ""
  echo -e "${BOLD}\$ TARGET_PATH=/wallet-risk REQUEST_BODY='{\"address\":\"$OFAC_ADDR\",\"chain\":\"xrpl\"}' \\\\"
  echo -e "    node --env-file=buyer.env.mainnet pay-and-fetch.mjs${RESET}"
  echo ""
  wait_beat

  TARGET_PATH=/wallet-risk \
  REQUEST_BODY="{\"address\":\"$OFAC_ADDR\",\"chain\":\"xrpl\"}" \
  node --env-file=buyer.env.mainnet pay-and-fetch.mjs

  echo ""
  echo -e "${BOLD}${RED}⚠ risk_level=critical, reason_codes populated${RESET} — same call price (\$0.0025), catches real threats"
}

cmd_full() {
  cmd_handshake
  echo ""
  echo -e "${DIM}[press Enter to continue to paid call #1]${RESET}"
  read -r _
  cmd_paid_clean
  echo ""
  echo -e "${DIM}[press Enter to continue to sanctioned address demo]${RESET}"
  read -r _
  cmd_paid_sanctioned
  echo ""
  banner "🎉  Demo complete — api.txnguardian.com | github.com/Bubakooz22/xrpl-tollbooth | v0.7.0-mainnet"
}

case "${1:-full}" in
  handshake)        cmd_handshake ;;
  paid-clean)       cmd_paid_clean ;;
  paid-sanctioned|paid-ofac) cmd_paid_sanctioned ;;
  full|"")          cmd_full ;;
  *)
    echo "Usage: $0 [handshake|paid-clean|paid-sanctioned|full]"
    exit 1
    ;;
esac
