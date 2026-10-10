#!/usr/bin/env bash
# Petri stage demo:
#   1. Verify       a second key re-runs a version and signs the result.
#   2. Selfie Check the web page opens. Press Space: the check is marked verified,
#                   and the page sends the records to Hedera and shows the hash.
#
#   ./demo/verify-demo.sh [nodeId]        # default: ec1d39e6
#
# The Selfie Check on that page is SIMULATED, and the page says so. The record it
# sends to Hedera carries `simulated: true`. The Hedera push is real.
#
# Before the demo:
#   - `npm run dev` at the repository root
#   - a topic: `pnpm petri anchor create --network testnet`
#   - the Hedera account in petri/.env (HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY)
set -euo pipefail
cd "$(dirname "$0")/.."

NODE="${1:-ae0acec3}"
KEY="${PETRI_DEMO_KEY:-$HOME/petri-demo-keys/k3}"
OUT="$(mktemp)"

P=$'\033[35m'; B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
step () { printf '\n%s━━ %s %s\n\n' "$P$B" "$1" "$R"; }

step "1/2  Verify $NODE"
echo "${D}\$ PETRI_HOME=$KEY pnpm petri verify $NODE${R}"
# Hold the Hedera push for the page, so the page shows the hash.
PETRI_HOME="$KEY" PETRI_ANCHOR_AUTO=0 pnpm -s petri verify "$NODE" | grep -v '^world id\|^selfie ' | tee "$OUT"

REPORT="$(grep -oE '^report +[0-9a-f]{64}' "$OUT" | awk '{print $2}' || true)"
rm -f "$OUT"
URL="http://localhost:3000/selfie?node=${NODE}&report=${REPORT}"

step "2/2  Selfie Check and Hedera"
echo "Opening $URL"
echo "Press Space on the page."
if command -v open >/dev/null 2>&1; then open "$URL"; fi
