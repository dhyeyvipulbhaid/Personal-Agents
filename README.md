# Personal Agents

Personal Agents is a workspace for an employee on a work laptop. It installs without admin rights and runs only with that person's permissions. Chat, a widget page, a natural-language widget builder, memory, a browser agent, and an approvals list live in one app, and each part is a plugin. Version 1 is a local demo: models run in Ollama on the machine, and data comes from local files.

**Status.** Version 1 demo is described in `docs/demo/v1-script.md`. It covers install, chat, the revenue tile, mail, the builder, memory, an approval, and a browser task.

Chat can read a page after one approval, and it can drive the Chrome already installed on the computer. Navigate, click, and type each ask first.

The window is one shell for every page: Home, Chat, Approvals, Activity, Capabilities, Builder, Memory, and Mail. Chat, the agent, and the builder use `qwen3:4b`, `qwen3:8b`, and `qwen2.5-coder:7b`. Pull a missing model with `ollama pull <model>`. The sample revenue file and the demo mailbox are copied into the app data folder the first time the host starts. A page says what failed and what to do when a dependency is missing.

## Chat memory

When a chat reply finishes, the app asks the local model to pull facts out of that exchange. The save runs in the background, so a slow model does not hold the reply on screen. The next message you send reads those facts back into the prompt. Saving a fact on the Memory page writes to the same place. If the save or the read fails, chat still answers, and a failed save writes nothing. A reply that never finishes is not saved.

Facts live in one SQLite file, `memory-bank.sqlite`, inside the app data folder. On macOS that folder is `~/Library/Application Support/com.personalagents.desktop`. On Windows it is `%LOCALAPPDATA%\com.personalagents.desktop`. The file is not encrypted. This version has one chat agent, named `chat`. A fact saved for that agent is visible in later chats. A different agent id in the same file cannot read it.

Each prompt gets at most 400 tokens of facts. A token here is `ceil(characters / 4)` of the fact text. Extraction uses the agent model (`qwen3:8b` unless you change it on Chat) at `127.0.0.1:11434`, with thinking turned off. Pull it with `ollama pull qwen3:8b`. The store is the [memory-bank](https://github.com/dhyeyvipulbhaid/memory-bank) library at commit `5639870198b8250e32bc9e53ddf6cb8ad924ef1d`.

## Repo layout

- `apps/desktop` is the desktop shell, a Tauri 2 window. The page is bundled with the app.
- `packages/host` is the agent host, a Bun and TypeScript process. The shell starts it and exchanges JSON-RPC on stdin and stdout. It answers `ping`, `version`, and `widgets`. It loads plugins by calling `apply(ctx)`, and it checks that SQLite opens.
- `docs/decisions` holds short records of stack choices. `0001-stack.md` records Tauri 2, the Bun host, SQLite, and stdio.
- `.github/workflows/ci.yml` is the pipeline. It runs on Windows and macOS. It checks the TypeScript packages, builds the installers, and runs the hello-widget theme flow in a browser.

## Run checks locally

Install [Bun](https://bun.sh) 1.4.4, then from the repository root:

```
bun install
bun run lint
bun run typecheck
bun run test
```

`lint` checks formatting and the linter. `typecheck` runs the TypeScript compiler without emitting files. `test` runs the unit tests. All three should pass before a change is pushed. The same three commands run in CI on `windows-latest` and `macos-latest`. The packaging job installs the app, checks that the agent host is running, checks that it is back within 3 seconds after it is stopped, and checks that the app and the host are not listening on a TCP or UDP port.

`bun run test:e2e` opens the desktop pages in a browser. One of those checks starts the real agent host and fails if a page says it is unavailable while its data is present. The same run writes light and dark screenshots of each page to `artifacts/ui-screenshots/`. CI uploads that folder.

## Build and install

Install [Bun](https://bun.sh) 1.4.4 and Rust 1.90 or newer. The window uses the system web view. Windows 11 already includes it. The installer does not add it, so it does not need an administrator.

From the repository root, install the JavaScript dependencies:

```
bun install
```

From the repository root, compile the agent host into one binary:

```
bun run build:host
```

From `apps/desktop`, build the package:

```
bunx tauri build
```

The host binary is inside the installed app. The computer does not need Bun installed to run it.

On Windows the build writes an NSIS installer at `apps/desktop/src-tauri/target/release/bundle/nsis/`. Run that `.exe`. It installs for the current user under `%LOCALAPPDATA%\Personal Agents` and does not ask for an administrator password. A Start Menu shortcut is created under your user profile. Uninstall from Windows Settings, or run `%LOCALAPPDATA%\Personal Agents\uninstall.exe`.

On macOS the build writes `Personal Agents.app` at `apps/desktop/src-tauri/target/release/bundle/macos/`. CI ad-hoc signs the app and the `agent-host` binary inside it (`codesign --force --deep --sign -`), checks that signature (`codesign --verify --deep --strict`), and then zips the app. Unzip the app into `~/Applications` and open it. A download keeps the `com.apple.quarantine` attribute, and macOS then says the app is damaged and can't be opened. Remove that attribute without sudo:

```
xattr -dr com.apple.quarantine "$HOME/Applications/Personal Agents.app"
```

`sh install.sh --url <bundle-url> --sha <sha256>` installs under the home folder and removes `com.apple.quarantine` from the installed app. There is no administrator password. Remove the app by moving it from `~/Applications` to the Trash.

Hand checklists live in `docs/manual-tests/`. They cover install, the host, plugins, the user installer, the locked-down gate, activity, approvals, models, chat, files, the revenue tile, local mail, and chat memory.

## Roadmap at a glance

1. **Pipeline.** CI on Windows and Mac.
2. **Installable shell.** Install the window for one user.
3. **Local backend.** The window starts the agent host and shows its version.
4. **Plugin kernel.** Load the hello widget.
5. **Grants and approvals (now).** Install for one user, record decisions, and pause a task for approval.
6. **Demo.** Chat, a revenue widget, a demo mailbox, the builder, memory, and the browser agent. Everything stays on the machine.
7. **Locked-down check.** Run that demo on a machine with strict IT controls.
8. **Pilot hardening.** Encryption, tighter approvals, and tracing, before real user data.
9. **Signing and IT rollout.** Only if an unsigned app is blocked, or when IT is ready to deploy the app.
