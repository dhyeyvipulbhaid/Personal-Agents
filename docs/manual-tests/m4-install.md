# M4 one-line install check

Run this on device A and again on device B. Both accounts must be standard accounts. Ollama should be installed for the first pass, then stopped for the second.

The installers are `install.sh` and `install.ps1`. They are unsigned. They check the bundle SHA-256 and change only the user PATH. CI ad-hoc signs the macOS app, including `agent-host`, before it zips the app.

## Windows

```
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Url <bundle-url> -Sha <sha256>
```

1. The app installs for the current user and launches. There is no administrator password prompt.
2. The user Path includes the install folder. The machine Path does not.
3. Stop Ollama. Open Personal Agents. The page says Ollama is not running and links to the Ollama installer.

## macOS

```
sh install.sh --url <bundle-url> --sha <sha256>
```

1. The app installs under the home folder and launches. The installer does not use sudo.
2. The installer removes `com.apple.quarantine` from `~/.local/personal-agents/personal-agents`. If macOS says the app is damaged and can't be opened, run this without sudo:

```
xattr -dr com.apple.quarantine "$HOME/.local/personal-agents/personal-agents"
```

3. `~/.profile` adds `$HOME/.local/bin` to PATH. System path files are unchanged.
4. Stop Ollama. Open Personal Agents. The page says Ollama is not running and links to the Ollama installer.
