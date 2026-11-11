# Personal Agents

Personal Agents is a workspace for an employee on a work laptop. It installs without admin rights and runs only with that person's permissions. Chat, a widget page, a natural-language widget builder, memory, a browser agent, and an approvals list live in one app, and each part is a plugin. Version 1 is a local demo: models run in Ollama on the machine, and data comes from local files.

**Status.** Milestone M1 is an installable desktop window. It shows the name Personal Agents and the version. The agent host and the plugins are not in this window yet.

## Repo layout

- `apps/desktop` is the desktop shell, a Tauri 2 window. The page is bundled with the app.
- `packages/host` is the agent host, a Bun and TypeScript process. Today it only checks that SQLite opens. The shell will talk to it over stdio later.
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

`lint` checks formatting and the linter. `typecheck` runs the TypeScript compiler without emitting files. `test` runs the unit tests. All three should pass before a change is pushed. The same three commands run in CI on `windows-latest` and `macos-latest`.

## Build and install

Install [Bun](https://bun.sh) 1.4.4 and Rust 1.90 or newer. The window uses the system web view. Windows 11 already includes it. The installer does not add it, so it does not need an administrator.

From the repository root, install the JavaScript dependencies:

```
bun install
```

From `apps/desktop`, build the package:

```
bunx tauri build
```

On Windows the build writes an NSIS installer at `apps/desktop/src-tauri/target/release/bundle/nsis/`. Run that `.exe`. It installs for the current user under `%LOCALAPPDATA%\Personal Agents` and does not ask for an administrator password. A Start Menu shortcut is created under your user profile. Uninstall from Windows Settings, or run `%LOCALAPPDATA%\Personal Agents\uninstall.exe`.

On macOS the build writes `Personal Agents.app` at `apps/desktop/src-tauri/target/release/bundle/macos/`. Zip that app to move it, unzip it into `~/Applications`, and open it. The app is not signed. macOS may ask you to confirm an unknown developer. That confirmation is not an administrator password. Remove the app by moving it from `~/Applications` to the Trash.

A hand checklist for a standard account is in `docs/manual-tests/m1-install.md`.

## Roadmap at a glance

1. **Pipeline.** CI on Windows and Mac.
2. **Installable shell (now).** Install the window for one user.
3. **Walking skeleton.** Start the local host and load one plugin.
4. **Demo.** Chat, a revenue widget, a demo mailbox, the builder, memory, approvals, and the browser agent. Everything stays on the machine.
5. **Locked-down check.** Run that demo on a machine with strict IT controls.
6. **Pilot hardening.** Encryption, tighter approvals, and tracing, before real user data.
7. **Signing and IT rollout.** Only if an unsigned app is blocked, or when IT is ready to deploy the app.
