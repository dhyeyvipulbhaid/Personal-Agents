# M4 one-line install check

Run this on device A and again on device B. Both accounts must be standard accounts. Ollama should be installed for the first pass, then stopped for the second.

The installers are `install.sh` and `install.ps1`. They are unsigned. They check the bundle SHA-256 and change only the user PATH.

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

1. The app installs under the home folder and launches. An unknown-developer confirmation is not an administrator password.
2. `~/.profile` adds `$HOME/.local/bin` to PATH. System path files are unchanged.
3. Stop Ollama. Open Personal Agents. The page says Ollama is not running and links to the Ollama installer.
