#!/bin/sh
# Unsigned user installer. It downloads or copies one bundle, checks SHA-256,
# unpacks under the user home, and adds only that user's bin directory to PATH.
set -eu

file=""
url=""
sha=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file)
      file="$2"
      shift 2
      ;;
    --url)
      url="$2"
      shift 2
      ;;
    --sha)
      sha="$2"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$sha" ]; then
  echo "pass --sha" >&2
  exit 2
fi

home="${PA_HOME:-$HOME}"
work="$home/.local/share/personal-agents"
mkdir -p "$work"
dest="$work/bundle.bin"

if [ -n "$url" ]; then
  curl -fsSL "$url" -o "$dest"
elif [ -n "$file" ]; then
  cp "$file" "$dest"
else
  echo "pass --url or --file" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$dest" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$dest" | awk '{print $1}')
fi
expected=$(printf '%s' "$sha" | tr 'A-F' 'a-f')
if [ "$actual" != "$expected" ]; then
  echo "sha256 mismatch" >&2
  rm -f "$dest"
  exit 1
fi

install_dir="$home/.local/personal-agents"
mkdir -p "$install_dir"
cp "$dest" "$install_dir/personal-agents"
chmod +x "$install_dir/personal-agents"
# A downloaded file keeps com.apple.quarantine. Clearing it does not need an admin password.
if [ "$(uname -s)" = "Darwin" ]; then
  if xattr -p com.apple.quarantine "$install_dir/personal-agents" >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$install_dir/personal-agents"
  fi
fi

bindir="$home/.local/bin"
mkdir -p "$bindir"
ln -sfn "$install_dir/personal-agents" "$bindir/personal-agents"

profile="$home/.profile"
line='export PATH="$HOME/.local/bin:$PATH"'
if ! grep -qxF "$line" "$profile" 2>/dev/null; then
  printf '\n%s\n' "$line" >> "$profile"
fi

ollama_running() {
  if [ "${PA_OLLAMA_STATUS:-}" = "running" ]; then
    return 0
  fi
  if [ "${PA_OLLAMA_STATUS:-}" = "stopped" ]; then
    return 1
  fi
  if ! command -v ollama >/dev/null 2>&1; then
    return 1
  fi
  curl -fsS --max-time 1 http://127.0.0.1:11434/api/tags >/dev/null 2>&1
}

if ! ollama_running; then
  echo "Ollama is not running. Install it from https://ollama.com/download"
fi
