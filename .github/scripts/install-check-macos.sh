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
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  fi
  if [ -n "${host_bin:-}" ]; then
    pkill -f "$host_bin" 2>/dev/null || true
  fi
}

now_ms() {
  perl -MTime::HiRes=time -e 'printf "%d\n", time() * 1000'
}

port_check() {
  local label="$1"
  local host_pid="$2"
  local pids="$pid"
  local child
  for child in $(pgrep -P "$pid" || true); do
    pids="$pids,$child"
  done
  case ",$pids," in
    *,"$host_pid",*) ;;
    *) pids="$pids,$host_pid" ;;
  esac
  echo "port check ($label): lsof -nP -a -p $pids -iTCP -sTCP:LISTEN and -iUDP"
  local tcp udp
  tcp="$(lsof -nP -a -p "$pids" -iTCP -sTCP:LISTEN 2>/dev/null || true)"
  udp="$(lsof -nP -a -p "$pids" -iUDP 2>/dev/null || true)"
  if [ -n "$tcp" ]; then
    echo "TCP listen ($label):" >&2
    echo "$tcp" >&2
    exit 1
  fi
  echo "TCP listen ($label): none"
  if [ -n "$udp" ]; then
    echo "UDP listen ($label):" >&2
    echo "$udp" >&2
    exit 1
  fi
  echo "UDP listen ($label): none"
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
host_bin="$app/Contents/MacOS/agent-host"
if [ ! -x "$host_bin" ]; then
  echo "agent host binary missing: $host_bin" >&2
  exit 1
fi
case "$host_bin" in
  "$HOME"/*) ;;
  *)
    echo "agent host is outside the home folder: $host_bin" >&2
    exit 1
    ;;
esac
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

root="$(cd "$(dirname "$0")/../.." && pwd)"
host_log="$support/host.log"
expected="$(awk -F'"' '/"version":/ { print $4; exit }' "$root/packages/host/package.json")"
if [ -z "$expected" ]; then
  echo "host package version is empty" >&2
  exit 1
fi

ready_deadline=$(( $(now_ms) + 20000 ))
while [ "$(now_ms)" -lt "$ready_deadline" ]; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Personal Agents exited early" >&2
    cat "$log" >&2 || true
    cat "$host_log" >&2 || true
    exit 1
  fi
  if [ -f "$host_log" ] && grep -q '^host-started pid=' "$host_log" && grep -q '^displayed-host-version: ' "$host_log"; then
    break
  fi
  sleep 0.2
done
if ! grep -q '^displayed-host-version: ' "$host_log" 2>/dev/null; then
  echo "agent host did not report a version" >&2
  cat "$host_log" >&2 || true
  cat "$log" >&2 || true
  exit 1
fi

first_started="$(awk '/^host-started pid=/ { print; exit }' "$host_log")"
host_pid="${first_started#host-started pid=}"
host_pid="${host_pid%% version=*}"
host_version="${first_started##* version=}"
displayed="$(awk '/^displayed-host-version: / { sub(/^displayed-host-version: /, ""); print; exit }' "$host_log")"
if [ "$host_version" != "$expected" ] || [ "$displayed" != "$expected" ]; then
  echo "version mismatch host=$host_version displayed=$displayed expected=$expected" >&2
  exit 1
fi
echo "agent host version: $host_version"
echo "displayed host version: $displayed"
if ! kill -0 "$host_pid" 2>/dev/null; then
  echo "agent host pid $host_pid is not running" >&2
  exit 1
fi
host_command="$(ps -ww -p "$host_pid" -o command= | sed 's/^[[:space:]]*//')"
case "$host_command" in
  "$host_bin"|"$host_bin "*|*"/agent-host"|*"/agent-host "*) ;;
  *)
    echo "agent host command is: $host_command" >&2
    exit 1
    ;;
esac
parent="$(ps -p "$host_pid" -o ppid= | tr -d '[:space:]')"
if [ "$parent" != "$pid" ]; then
  echo "agent host parent is $parent, expected $pid" >&2
  exit 1
fi

port_check "before restart" "$host_pid"

start_ms="$(now_ms)"
kill -9 "$host_pid"
new_pid=""
while [ $(( $(now_ms) - start_ms )) -lt 3000 ]; do
  last_started="$(awk '/^host-started pid=/ { line=$0 } END { print line }' "$host_log")"
  candidate="${last_started#host-started pid=}"
  candidate="${candidate%% version=*}"
  if [ -n "$candidate" ] && [ "$candidate" != "$host_pid" ] && kill -0 "$candidate" 2>/dev/null; then
    new_pid="$candidate"
    break
  fi
  sleep 0.1
done
elapsed_ms=$(( $(now_ms) - start_ms ))
if [ -z "$new_pid" ]; then
  echo "agent host was not back within 3 seconds (${elapsed_ms}ms)" >&2
  cat "$host_log" >&2 || true
  exit 1
fi
if ! kill -0 "$pid" 2>/dev/null; then
  echo "Personal Agents exited when the agent host was stopped" >&2
  exit 1
fi
new_parent="$(ps -p "$new_pid" -o ppid= | tr -d '[:space:]')"
if [ "$new_parent" != "$pid" ]; then
  echo "restarted host parent is $new_parent, expected $pid" >&2
  exit 1
fi
new_version="$(awk -v pid="$new_pid" '
  index($0, "host-started pid=" pid " version=") == 1 {
    line = substr($0, length("host-started pid=" pid " version=") + 1)
  }
  END { print line }
' "$host_log")"
if [ "$new_version" != "$expected" ]; then
  echo "restarted host version $new_version != $expected" >&2
  exit 1
fi
echo "host restart seconds: $(perl -e "printf \"%.3f\", $elapsed_ms / 1000")"
echo "restarted host pid: $new_pid"

port_check "after restart" "$new_pid"

pkill -P "$pid" 2>/dev/null || true
pkill -f "$host_bin" 2>/dev/null || true
kill "$pid" 2>/dev/null || true
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
