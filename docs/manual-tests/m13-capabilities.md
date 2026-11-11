# M13 capabilities check

On device A, open Capabilities. Folders, the browser, remote debugging, the Ollama port, and the installed models show as available.

On a test machine, set the Chrome policy `RemoteDebuggingAllowed` to false. The panel shows remote debugging as blocked and names that policy. `bun packages/host/src/doctor.ts` prints the same kind of lines. The policy case runs in CI. The all-available case is this device check.
