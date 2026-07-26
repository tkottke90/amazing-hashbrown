#!/usr/bin/env bash
# Runs one `npm run eval` invocation for a single model against a single
# suite, tees the full output somewhere reviewable, and prints a small set
# of `key=value` lines that are trivial to parse — so the calling agent
# never has to regex-hunt through eval's human-readable console output for
# the "Result:" line, guess the exit code's meaning, or lose the debug log
# path. This is the same information a human running the command by hand
# would read off the terminal; it's just extracted once, reliably, here.
#
# Usage:
#   run-eval-round.sh <suite> <model> <judge-model> <round-id> [--debug]
#
# Output (stdout), one line per field, nothing else on stdout:
#   result_yaml=<path or empty if not found>
#   report_html=<path or empty>
#   exit_code=<0|1|2|3>
#   debug_log=<path, only present if --debug was passed>
#
# Exit code mirrors bin/eval.ts's own contract (0 pass, 1 fail, 2 bad args,
# 3 runtime error) — the caller should treat 2/3 as "the run itself broke,"
# not as an eval failure to diagnose and fix.
set -euo pipefail

SUITE="${1:?suite is required}"
MODEL="${2:?model is required}"
JUDGE="${3:?judge model is required}"
ROUND_ID="${4:?round id is required}"
DEBUG_FLAG="${5:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="eval-logs/run-logs"
mkdir -p "$LOG_DIR"
COMBINED_LOG="$LOG_DIR/round-${ROUND_ID}-${MODEL}.log"

CMD=(npm run eval -- --suite "$SUITE" --model "$MODEL" --judge-model "$JUDGE")

if [ "$DEBUG_FLAG" = "--debug" ]; then
  set +e
  DEBUG_LLM_HTTP=1 "${CMD[@]}" >"$COMBINED_LOG" 2>&1
  EXIT_CODE=$?
  set -e
else
  set +e
  "${CMD[@]}" >"$COMBINED_LOG" 2>&1
  EXIT_CODE=$?
  set -e
fi

RESULT_YAML="$(grep -oE 'Result:\s+\S+\.yaml' "$COMBINED_LOG" | tail -1 | awk '{print $2}' || true)"
REPORT_HTML="$(grep -oE 'Report:\s+\S+\.html' "$COMBINED_LOG" | tail -1 | awk '{print $2}' || true)"

echo "result_yaml=${RESULT_YAML}"
echo "report_html=${REPORT_HTML}"
echo "exit_code=${EXIT_CODE}"
if [ "$DEBUG_FLAG" = "--debug" ]; then
  echo "debug_log=${COMBINED_LOG}"
fi

# Always echo where the full console output went, debug or not — useful if
# the result_yaml line failed to extract (e.g. a runtime error before any
# suite ran) and the agent needs to see what actually happened.
echo "console_log=${COMBINED_LOG}"
