# Personal Agents

Personal Agents is a workspace for an employee on a work laptop. It installs without admin rights and runs only with that person's permissions. Chat, a widget page, a natural-language widget builder, memory, a browser agent, and an approvals list live in one app, and each part is a plugin. Version 1 is a local demo: models run in Ollama on the machine, and data comes from local files.

**Status.** Milestone M2 is the local backend. The window starts the agent host and shows the host version. Plugins are not loaded yet.

## Repo layout

- `apps/desktop` is the desktop shell, a Tauri 2 window. The page is bundled with the app.
- `packages/host` is the agent host, a Bun and TypeScript process. The shell starts it and exchanges JSON-RPC on stdin and stdout. It answers `ping` and `version`. It also checks that SQLite opens.
- `docs/decisions` holds short records of stack choices. `0001-stack.md` records Tauri 2, the Bun host, SQLite, and stdio.
- `.github/workflows/ci.yml` is the pipeline. It runs on Windows and macOS. It checks the TypeScript packages, builds the installers, and has an empty job reserved for end-to-end UI flow tests.

## Run checks locally

Install [Bun](https://bun.sh) 1.4.4, then from the repository root:

```
bun install
bun run lint
bun run typecheck
bun run test
```

`lint` checks formatting and the linter. `typecheck` runs the TypeScript compiler without emitting files. `test` runs the unit tests. All three should pass before a change is pushed. The same three commands run in CI on `windows-latest` and `macos-latest`. The packaging job installs the app, checks that the agent host is running, checks that it is back within 3 seconds after it is stopped, and checks that the app and the host are not listening on a TCP or UDP port.

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

On macOS the build writes `Personal Agents.app` at `apps/desktop/src-tauri/target/release/bundle/macos/`. Zip that app to move it, unzip it into `~/Applications`, and open it. The app is not signed. macOS may ask you to confirm an unknown developer. That confirmation is not an administrator password. Remove the app by moving it from `~/Applications` to the Trash.

A hand checklist for a standard account is in `docs/manual-tests/m1-install.md`. The host checklist is in `docs/manual-tests/m2-backend.md`.

## Roadmap at a glance

1. **Pipeline.** CI on Windows and Mac.
2. **Installable shell.** Install the window for one user.
3. **Local backend (now).** The window starts the agent host and shows its version.
4. **Walking skeleton.** Load one plugin.
5. **Demo.** Chat, a revenue widget, a demo mailbox, the builder, memory, approvals, and the browser agent. Everything stays on the machine.
6. **Locked-down check.** Run that demo on a machine with strict IT controls.
7. **Pilot hardening.** Encryption, tighter approvals, and tracing, before real user data.
8. **Signing and IT rollout.** Only if an unsigned app is blocked, or when IT is ready to deploy the app.
