# 0001 — Stack

Status: accepted
Date: 2026-11-11

## Decision

The desktop shell is Tauri 2. The agent host is a Bun process written in TypeScript. Local data is SQLite. The shell and the host talk over stdio, not a network port.

## Why

The app has to install for one user on Windows and Mac without admin rights, and it must not open a listening port. Tauri 2 is a small native window (the system webview) with a Rust side that can later own permissions and the audit log. The window can stay up if the agent host crashes.

The host is TypeScript so each plugin can be an ordinary module. Bun runs TypeScript directly, includes SQLite, and can later be compiled to one binary, so a work laptop does not need Node installed.

SQLite is one file on the device. There is no database server to install. Later milestones can use its full-text search for memory. The file stays on the machine.

The shell will start the host as a child process and exchange JSON-RPC on stdin and stdout. With no TCP port, other programs on the laptop cannot connect to the host. The only local port the demo expects is Ollama's, and that process belongs to Ollama.

## Not in this decision

Installers, the plugin kernel, and the JSON-RPC methods come in later milestones. This record only fixes the four choices above. Milestone M0 checks the TypeScript packages in CI. It does not compile the Tauri window yet.
