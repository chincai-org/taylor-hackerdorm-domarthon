#!/usr/bin/env bash
# Petri demo in three parts, from the repository root: pnpm demo:full [nodeId]
#
#   1. How it works   the digest every agent reads before it proposes a change
#   2. Run it         the harness runs the benchmark: the task, the model answer,
#                     the tests. Nothing is signed.
#   3. Verify it      a second key re-runs both sides, signs the result, and the
#                     record goes to the Hedera topic. Then the public copy is checked.
#
# Default version: ae0acec3 (1 of 2 keys). A key can verify a version only once,
# so part 3 runs once per version.
set -euo pipefail
cd "$(dirname "$0")/.."

NODE="${1:-ae0acec3}"
KEY="${PETRI_DEMO_KEY:-$HOME/petri-demo-keys/k3}"
TASKS="${DEMO_TASKS:-3}"
BANNER='^(PETRI|TRUST|MODE) |^  (This log|One person|Only a Hedera|Run `petri topic|Replay re-runs|The tests genuinely|A replay number)|^Already up to date|^Done in '

P=$'\033[35m'; B=$'\033[1m'; D=$'\033[2m'; R=$'\033[0m'
step () { printf '\n%s━━━━ %s %s\n' "$P$B" "$1" "$R"; }
pause () { if [ -t 0 ]; then printf '%s(press Enter)%s' "$D" "$R"; read -r _; fi; }

step "1/3  How it works: what every agent reads"
echo "${D}\$ pnpm petri digest${R}"
pnpm -s petri digest 2>/dev/null | awk '/^## 3\./ { exit } { print }'
pause

step "2/3  Run the harness of $NODE"
echo "${D}\$ pnpm petri run $NODE --tasks $TASKS${R}"
pnpm -s petri run "$NODE" --tasks "$TASKS" 2>&1 | grep -vE "$BANNER"
pause

step "3/3  Verify it with a second key, then Hedera"
echo "${D}\$ PETRI_HOME=$KEY pnpm petri verify $NODE --show${R}"
PETRI_HOME="$KEY" pnpm -s petri verify "$NODE" --show 2>&1 | grep -vE "$BANNER" | grep -v '^world id\|^selfie '
pause

echo "${D}\$ pnpm petri hedera check${R}"
pnpm -s petri hedera check 2>/dev/null
