import type { Page } from "playwright";
import type { HostClient } from "./host-client.ts";

export async function installBridge(
  page: Page,
  host: HostClient,
): Promise<void> {
  await page.exposeFunction(
    "hostInvoke",
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "note_displayed_host_version") {
        return null;
      }
      if (command === "audit_log") {
        return JSON.stringify(host.audits);
      }
      if (command === "host_version") {
        return host.call("version");
      }
      if (command === "ollama_status") {
        return host.call("ollama");
      }
      return host.call(command, args);
    },
  );
  await page.addInitScript(() => {
    const bridge = window as unknown as {
      hostInvoke: (command: string, args?: unknown) => Promise<unknown>;
    };
    Object.defineProperty(window, "__TAURI__", {
      configurable: true,
      value: {
        core: {
          invoke: (command: string, args?: unknown) =>
            bridge.hostInvoke(command, args),
        },
      },
    });
  });
}
