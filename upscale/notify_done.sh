#!/bin/sh
# Bounded watcher: notifies when an upscale output file lands, then exits. Max ~2.5 h.
# Usage: ./notify_done.sh <expected-output-file> [process-pattern=safe_upscale.py]
OUT="$1"; PAT="${2:-safe_upscale.py}"; N=0
[ -n "$OUT" ] || { echo "usage: $0 <expected-output-file> [process-pattern]"; exit 2; }
LOG="$(dirname "$0")/notify.log"
notify() {
  if command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$2\" with title \"$1\"" 2>/dev/null
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "$1" "$2"
  fi
}
while [ $N -lt 900 ]; do
  if [ -f "$OUT" ]; then
    notify "Upscale complete" "$OUT"
    echo "$(date '+%F %T') COMPLETE $OUT" >> "$LOG"; exit 0
  fi
  if ! pgrep -f "$PAT" >/dev/null 2>&1; then
    notify "Upscale stopped" "Stopped before finishing; re-run the same command to resume"
    echo "$(date '+%F %T') STOPPED (process gone, no output)" >> "$LOG"; exit 1
  fi
  N=$((N+1)); sleep 10
done
echo "$(date '+%F %T') watcher timed out" >> "$LOG"
