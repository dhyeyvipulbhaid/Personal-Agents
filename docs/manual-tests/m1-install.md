# M1 install check

Run this on device A and again on device B. Both accounts must be standard accounts, not administrators. Use the Windows section or the macOS section for that device.

The window should show **Personal Agents** and **Version 0.0.0**. Quit the app before you uninstall it.

Build the package with the steps in the README, or take the `personal-agents-windows` and `personal-agents-macos` files from the packaging workflow. Continuous integration installs silently and checks paths. It cannot see a password prompt on your screen. This checklist is that check.

## Windows

1. Double-click the NSIS setup `.exe`.
2. There must be no User Account Control prompt ("Do you want to allow this app to make changes to your device?"). A prompt is a failure.
3. On the last page, leave the desktop shortcut unchecked. Finish the install.
4. Open Personal Agents from the Start Menu. The window title is Personal Agents. The page says Personal Agents and Version 0.0.0. Quit the app.

These paths should exist. Replace `<account>` with the Windows user name.

- `C:\Users\<account>\AppData\Local\Personal Agents\personal-agents.exe`
- `C:\Users\<account>\AppData\Local\Personal Agents\uninstall.exe`
- `C:\Users\<account>\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Personal Agents\Personal Agents.lnk`
- `C:\Users\<account>\AppData\Local\com.personalagents.desktop` (created when the window opens)

In Registry Editor, this key should exist:

- `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Personal Agents`

Its `InstallLocation` value should be `C:\Users\<account>\AppData\Local\Personal Agents`. This key should also exist:

- `HKEY_CURRENT_USER\Software\Personal Agents\Personal Agents`

These must not exist:

- `C:\Program Files\Personal Agents`
- `C:\Program Files (x86)\Personal Agents`
- `C:\ProgramData\Personal Agents`
- `C:\Users\Public\Desktop\Personal Agents.lnk`
- `HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\Personal Agents`
- `HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Personal Agents`
- `HKEY_LOCAL_MACHINE\Software\Personal Agents`

Uninstall from Windows Settings, or run `C:\Users\<account>\AppData\Local\Personal Agents\uninstall.exe`. There must be no User Account Control prompt.

After uninstall, every path and registry key in the "should exist" lists is gone. The "must not exist" list is still absent.

## macOS

1. Unzip `Personal Agents.app` into `/Users/<account>/Applications`. Create that Applications folder if it is not there. Do not copy the app to `/Applications`.
2. Open the app. macOS may say it cannot verify the developer, because the app is not signed. Use the confirmation that opens the app. There must be no prompt for an administrator password. A password prompt is a failure.
3. The window title is Personal Agents. The page says Personal Agents and Version 0.0.0. Quit the app.

These paths should exist:

- `/Users/<account>/Applications/Personal Agents.app`
- `/Users/<account>/Library/Application Support/com.personalagents.desktop` (created when the window opens)

The web view may also create folders under the home folder. They are still your files:

- `/Users/<account>/Library/WebKit/com.personalagents.desktop`
- `/Users/<account>/Library/Caches/com.personalagents.desktop`
- `/Users/<account>/Library/HTTPStorages/com.personalagents.desktop`
- `/Users/<account>/Library/Preferences/com.personalagents.desktop.plist`

These must not exist:

- `/Applications/Personal Agents.app`
- `/Library/Application Support/com.personalagents.desktop`
- `/Library/Preferences/com.personalagents.desktop.plist`

Move `/Users/<account>/Applications/Personal Agents.app` to the Trash and empty it. Delete the home-folder paths listed above if they are present.

After that, the app is gone from `~/Applications`, and the system paths in the "must not exist" list are still absent.
