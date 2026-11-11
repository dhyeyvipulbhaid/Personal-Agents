#!/bin/bash
# Unzip the app into ~/Applications, launch it, quit, and remove it.

set -euo pipefail

zip_path="${1:-personal-agents-macos.zip}"
if [ ! -f "$zip_path" ]; then
  echo "macOS zip was not produced: $zip_path" >&2
  exit 1
fi

dest="$HOME/Applications"
app="$dest/Personal Agents.app"
bin="$app/Contents/MacOS/personal-agents"
support="$HOME/Library/Application Support/com.personalagents.desktop"
log="$(mktemp)"
pid=""

cleanup() {
  if [ -n "${pid}" ]; then
    kill "$pid" 2>/dev/null || true
    pkill -P "$pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

rm -rf "$app"
mkdir -p "$dest"
ditto -x -k "$zip_path" "$dest"
xattr -dr com.apple.quarantine "$app" 2>/dev/null || true

if [ ! -d "$app" ]; then
  echo "app bundle missing after unzip: $app" >&2
  exit 1
fi
if [ ! -x "$bin" ]; then
  echo "app executable missing: $bin" >&2
  exit 1
fi
if [ -e "/Applications/Personal Agents.app" ]; then
  echo "app was written to /Applications" >&2
  exit 1
fi
if [ -e "/Library/Application Support/com.personalagents.desktop" ]; then
  echo "app data was written under /Library" >&2
  exit 1
fi

"$bin" >"$log" 2>&1 &
pid=$!

ready=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Personal Agents exited early" >&2
    cat "$log" >&2 || true
    exit 1
  fi
  if [ -d "$support" ]; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "app data was not created under $support" >&2
  echo "home library entries:" >&2
  ls -la "$HOME/Library/Application Support" >&2 || true
  ls -la "$HOME/Library/WebKit" >&2 || true
  ls -la "$HOME/Library/Caches" >&2 || true
  cat "$log" >&2 || true
  exit 1
fi

case "$support" in
  "$HOME"/*) ;;
  *)
    echo "app data is outside the home folder: $support" >&2
    exit 1
    ;;
esac

pids_csv="$pid"
child_pids="$(pgrep -P "$pid" || true)"
if [ -n "$child_pids" ]; then
  child_csv="$(printf '%s\n' "$child_pids" | tr '\n' ',' | sed 's/,$//')"
  pids_csv="$pid,$child_csv"
fi
listening="$(lsof -nP -a -p "$pids_csv" -iTCP -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$listening" ]; then
  echo "Personal Agents is listening on a TCP port:" >&2
  echo "$listening" >&2
  exit 1
fi

kill "$pid" 2>/dev/null || true
pkill -P "$pid" 2>/dev/null || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$pid" 2>/dev/null; then
    break
  fi
  sleep 1
done
pid=""

rm -rf "$app"
rm -rf "$support"
rm -rf "$HOME/Library/Caches/com.personalagents.desktop"
rm -rf "$HOME/Library/WebKit/com.personalagents.desktop"
rm -rf "$HOME/Library/Logs/com.personalagents.desktop"
rm -rf "$HOME/Library/HTTPStorages/com.personalagents.desktop"
rm -f "$HOME/Library/Preferences/com.personalagents.desktop.plist"
rm -f "$log"

if [ -e "$app" ]; then
  echo "app bundle was not removed: $app" >&2
  exit 1
fi
if [ -e "/Applications/Personal Agents.app" ]; then
  echo "app remains in /Applications" >&2
  exit 1
fi
if [ -e "/Library/Application Support/com.personalagents.desktop" ]; then
  echo "app data remains under /Library" >&2
  exit 1
fi

echo "macOS install check passed"
