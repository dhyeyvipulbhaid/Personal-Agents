# Personal Agents

Personal Agents is a workspace for an employee on a work laptop. It installs without admin rights and runs only with that person's permissions. Chat, a widget page, a natural-language widget builder, memory, a browser agent, and an approvals list live in one app, and each part is a plugin. Version 1 is a local demo: models run in Ollama on the machine, and data comes from local files.

**Status.** This repository is at milestone M0 (pipeline) of the roadmap. Continuous integration runs lint, type checks, and tests on Windows and macOS. The app window, the agent host process, and the product features are not built yet.

## Repo layout

- `apps/desktop` is the desktop shell. It will be a Tauri 2 app. Today it holds the Tauri config and a check that the config names this app.
- `packages/host` is the agent host, a Bun and TypeScript process. Today it only checks that SQLite opens. The shell will talk to it over stdio later.
- `docs/decisions` holds short records of stack choices. `0001-stack.md` records Tauri 2, the Bun host, SQLite, and stdio.
- `.github/workflows/ci.yml` is the pipeline. It runs on Windows and macOS, and it has an empty job reserved for end-to-end UI flow tests.

## Run checks locally

Install [Bun](https://bun.sh) 1.4.4, then from the repository root:

```
bun install
bun run lint
bun run typecheck
bun run test
```

`lint` checks formatting and the linter. `typecheck` runs the TypeScript compiler without emitting files. `test` runs the unit tests. All three should pass before a change is pushed. The same three commands run in CI on `windows-latest` and `macos-latest`.

## Roadmap at a glance

1. **Pipeline (now).** CI on Windows and Mac.
2. **Walking skeleton.** Install the app, start the local host, and load one plugin.
3. **Demo.** Chat, a revenue widget, a demo mailbox, the builder, memory, approvals, and the browser agent. Everything stays on the machine.
4. **Locked-down check.** Run that demo on a machine with strict IT controls.
5. **Pilot hardening.** Encryption, tighter approvals, and tracing, before real user data.
6. **Signing and IT rollout.** Only if an unsigned app is blocked, or when IT is ready to deploy the app.
