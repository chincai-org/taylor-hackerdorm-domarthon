#!/usr/bin/env bash
# Petri demo: one new version under ecc7cdb0 that states every prompt rule as a
# positive directive ("do this") instead of a prohibition ("do not do that").
#
#   ANTHROPIC_API_KEY=sk-ant-... ./demo/positive-prompt.sh
#
# It must be scored live. Replay holds recorded answers for the two existing
# harness versions only, so it cannot score a new one.
set -euo pipefail
cd "$(dirname "$0")/.."
MODE="${MODE:-live}"
if [ "$MODE" = "live" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Set ANTHROPIC_API_KEY first. This change is a new harness, so it must be scored live." >&2
  exit 2
fi

OUT=$(pnpm -s petri propose --parent ecc7cdb0 --area prompt --motif positive-instructions \
  --hypothesis "Stating each instruction as a positive directive, what the model must do, instead of what it must not do, raises the pass rate and cuts reply tokens, because the model spends less effort reasoning about prohibitions." \
  --falsified-if "The median score does not rise by at least 1000bp." --predict 1000 2>&1)
W=$(echo "$OUT" | grep -oE '/[^ ]*\.petri/scratch/[0-9a-f-]+' | head -1)
[ -n "$W" ] || { echo "$OUT" >&2; exit 1; }
H="$W/harness"; [ -d "$H" ] || H="$W"
cp demo/positive-prompt/prompt.ts "$H/prompt.ts"
echo "workspace $W"
pnpm petri submit --workspace "$W" --mode "$MODE"
