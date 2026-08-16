#!/usr/bin/env bash
# The ONLY sanctioned way to (re)start the historian — the bench gates the launch.
#
# History, so the gate's reason survives: the historian was first launched with its loop untested end-to-end
# (its parts were tested; the loop was not), and the first live question crashed it three ways. Brian's rule,
# 2026-08-16: restarts are gated on the bench run. The bench is hermetic — a sandbox drop-zone copied from
# the live channel, a scratch copy of the graph, a planted question with a known-answerable gold — and a
# launch happens only if the sandboxed historian produces a protocol-correct reply there.
#
# Usage: scripts/historian-restart.sh [model]   (default mistral-small:latest, the D2 ladder winner)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODEL="${1:-mistral-small:latest}"
COMMS="${HISTORIAN_COMMS:-$HOME/agent_to_agent_comms}"
BENCH="$(mktemp -d /tmp/historian-bench.XXXXXX)"
LOG="$COMMS/historian.log"

echo "== bench: sandbox at $BENCH =="
mkdir -p "$BENCH/messages" "$BENCH/control"
cp "$COMMS"/messages/0*.md "$BENCH/messages/"
echo '{"granted_epoch": 0, "turns": 99}' > "$BENCH/control/BUDGET"
rm -rf graphs/commstest && mkdir -p graphs/commstest
cp graphs/comms/graph.db graphs/commstest/graph.db
cp graphs/comms/meta.json graphs/commstest/meta.json

# The planted question: known-answerable, single-hop (QA item Q03's gold: llama4:scout).
cat > "$BENCH/messages/0900-bench.md" <<EOF
---
from: bench
to: historian
seq: 900
protocol: "1.6"
chars: 70
date: $(date -Iseconds)
subject: "bench: known-answerable probe"
---

Which model was the grounded skeptic in the original M1 measurement?
EOF

echo "== bench: running sandboxed historian (up to 8 min) =="
timeout 480 env HISTORIAN_COMMS="$BENCH" HISTORIAN_GRAPH=commstest HISTORIAN_MODEL="$MODEL" \
  node_modules/.bin/tsx scripts/historian.ts > "$BENCH/bench.log" 2>&1 &
BPID=$!
# Detect only a NEW reply to the PLANTED question. The first version of this gate grepped for any
# *historian* filename and instantly "passed" on the live historian reply the sandbox had COPIED IN —
# a vacuous gate, caught on its first run. The gate is an instrument too; baseline-then-diff, and bind
# the match to the planted seq.
BASELINE=$(ls "$BENCH/messages/")
REPLY=""
for _ in $(seq 1 96); do
  for f in $(ls "$BENCH/messages/" 2>/dev/null | grep "historian" || true); do
    echo "$BASELINE" | grep -qx "$f" && continue
    grep -q "^in_reply_to: 900$" "$BENCH/messages/$f" && REPLY="$f" && break
  done
  [ -n "$REPLY" ] && break
  sleep 5
done
kill "$BPID" 2>/dev/null || true

if [ -z "$REPLY" ]; then
  echo "BENCH FAILED: no historian reply produced. Log tail:"
  tail -5 "$BENCH/bench.log"
  echo "LAUNCH REFUSED."
  exit 1
fi
# Protocol-correctness of the reply: frontmatter, footer, lag line.
R="$BENCH/messages/$REPLY"
for needle in "from: historian" "in_reply_to:" "Indexed through seq" "never assertions"; do
  grep -q "$needle" "$R" || { echo "BENCH FAILED: reply missing '$needle'"; echo "LAUNCH REFUSED."; exit 1; }
done
# Content, not just form (review finding: a decline or a hallucination with boilerplate passed the old
# checks). The planted question's gold is llama4:scout (QA item Q03), and the reply must be grounded.
grep -qi "scout" "$R" || { echo "BENCH FAILED: reply lacks the gold answer (scout)"; echo "LAUNCH REFUSED."; exit 1; }
grep -q "Not in the record" "$R" && { echo "BENCH FAILED: reply declined a known-answerable question"; echo "LAUNCH REFUSED."; exit 1; }
grep -q "Every citation verified verbatim" "$R" || { echo "BENCH FAILED: reply not fully grounded"; echo "LAUNCH REFUSED."; exit 1; }
echo "== bench PASSED: $REPLY =="
grep -m1 "answered" "$BENCH/bench.log" || true

echo "== stopping any running historian =="
# Kill by exact pid list from pattern match on the TSX entrypoint — never pkill -f from a shell whose own
# command line contains the pattern (that mistake is in the memory file three times, and was made a fourth).
for pid in $(pgrep -f "tsx scripts/historian.ts" || true); do kill "$pid" 2>/dev/null || true; done
sleep 1

echo "== launching detached (model $MODEL) =="
setsid nohup env HISTORIAN_MODEL="$MODEL" node_modules/.bin/tsx scripts/historian.ts >> "$LOG" 2>&1 < /dev/null &
disown
sleep 5
if pgrep -f "tsx scripts/historian.ts" > /dev/null; then
  echo "historian up (log: $LOG)"
else
  echo "LAUNCH FAILED after passing bench — check $LOG"
  exit 1
fi
