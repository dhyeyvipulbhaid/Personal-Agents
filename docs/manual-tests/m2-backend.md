# M2 local backend check

Run this on device A and again on device B. Both accounts must be standard accounts, not administrators. Install with the steps in `docs/manual-tests/m1-install.md`, then use the section below for that device.

The window should show **Personal Agents**, **Version 0.0.0**, and **Agent host 0.0.0**. The host is inside the installed app. There is no second installer and no administrator password.

## Windows

1. Open Personal Agents from the Start Menu. The page says Personal Agents, Version 0.0.0, and Agent host 0.0.0.
2. In Task Manager, `personal-agents.exe` and `agent-host.exe` are running. `agent-host.exe` is under `C:\Users\<account>\AppData\Local\Personal Agents\`.
3. End the `agent-host.exe` task. Within 3 seconds a new `agent-host.exe` is running. The window stays open and still says Agent host 0.0.0.
4. Neither process is listening on a TCP or UDP port. In PowerShell:

```
Get-NetTCPConnection -OwningProcess <pid> -State Listen
Get-NetUDPEndpoint -OwningProcess <pid>
```

Replace `<pid>` with the process id of `personal-agents.exe` and again with `agent-host.exe`. No rows is a pass. A listening port is a failure.

Quit the app, then uninstall as in the M1 checklist. There must be no User Account Control prompt. `agent-host.exe` is removed with the install folder.

## macOS

1. Open Personal Agents from `~/Applications`. The page says Personal Agents, Version 0.0.0, and Agent host 0.0.0. An unknown-developer confirmation is not an administrator password.
2. In Activity Monitor, `personal-agents` and `agent-host` are running. `agent-host` is inside `Personal Agents.app`.
3. Stop `agent-host`. Within 3 seconds it is running again. The window stays open and still says Agent host 0.0.0.
4. Neither process is listening. In Terminal, replace `<pid>` with each process id:

```
lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN
lsof -nP -a -p <pid> -iUDP
```

No rows is a pass. A listening port is a failure.

Quit the app and remove it as in the M1 checklist. `agent-host` is removed with the app.
