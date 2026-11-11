# M3 plugin and theme check

Install with the M1 checklist and confirm the host with the M2 checklist. Then use the section for that device.

## Windows and macOS

1. Open Personal Agents. The page shows Personal Agents, Version 0.0.0, Agent host 0.0.0, and a Hello widget in its own frame.
2. Set Theme to Light. The page background is light, and the Hello frame is light.
3. Set Theme to Dark. The page background is dark, and the Hello frame is dark.
4. Set Theme to Follow system. Change the operating system appearance between light and dark. The page and the Hello frame follow it.
5. Quit and open the app again. The theme choice is still the one you set.

Quit and uninstall as in the M1 checklist. There must be no administrator password prompt.

Plugin code has no network access, and unloading a plugin removes its registrations. A plugin that hangs is stopped. Those three checks run in CI.
