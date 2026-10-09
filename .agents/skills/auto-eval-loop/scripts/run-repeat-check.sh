#!/usr/bin/env bash
# Confirms a round's scenario failures aren't sampling noise before the loop
# diagnoses or fixes them: reruns the suite 3x via `npm run eval:probe`
# under identical conditions, then classifies each requested scenario's
# outcomes (real/noise/inconclusive) via classify-repeat-check.mjs. The
# calling agent never parses probe.json itself — this script and the
# classifier it calls own that entirely.
#
# Usage:
#   run-repeat-check.sh <suite> <model> <judge-model> <round-id> <scenario-id-1>,<scenario-id-2>,...
#
# Output (stdout), one line per field, nothing else on stdout: relays
# classify-repeat-check.mjs's own key=value lines verbatim, then appends:
#   exit_code=<eval:probe's own exit code: 0 identical, 1 varied, 2 aborted, 3 incomplete/errored>
#   console_log=<path to the tee'd eval:probe console output>
set -euo pipefail

SUITE="${1:?suite is required}"
MODEL="${2:?model is required}"
JUDGE="${3:?judge model is required}"
ROUND_ID="${4:?round id is required}"
SCENARIO_IDS="${5:?comma-separated scenario ids are required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="eval-logs/run-logs"
mkdir -p "$LOG_DIR"
COMBINED_LOG="$LOG_DIR/round-${ROUND_ID}-${MODEL}-repeat-check.log"

set +e
npm run eval:probe -- --suite "$SUITE" --model "$MODEL" --judge-model "$JUDGE" --runs 3 \
  >"$COMBINED_LOG" 2>&1
EXIT_CODE=$?
set -e

PROBE_DIR="$(grep -oE 'Logs and probe\.json:\s+\S+' "$COMBINED_LOG" | tail -1 | awk '{print $NF}' || true)"

if [ -z "$PROBE_DIR" ]; then
  echo "exit_code=${EXIT_CODE}"
  echo "console_log=${COMBINED_LOG}"
  echo "run-repeat-check.sh: eval:probe produced no probe.json (likely a usage error before any run started); see console_log" >&2
  exit 1
fi

node "$SCRIPT_DIR/classify-repeat-check.mjs" \
  --probe-json "${PROBE_DIR}/probe.json" \
  --suite "$SUITE" \
  --model "$MODEL" \
  --scenario-ids "$SCENARIO_IDS"

echo "exit_code=${EXIT_CODE}"
echo "console_log=${COMBINED_LOG}"
