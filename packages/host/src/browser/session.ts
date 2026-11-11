import type { Approvals } from "../approvals/approvals.ts";
import type { Check } from "../capabilities/probe.ts";

export type Rung = 0 | 1 | 5;

export function chooseRung(checks: Check[]): {
  rung: Rung;
  explanation: string;
} {
  const remote = checks.find((check) => check.name === "remote debugging");
  if (remote?.status === "blocked") {
    return {
      rung: 5,
      explanation: `Remote debugging is blocked by ${remote.cause}, so rungs 0 and 1 were skipped.`,
    };
  }
  return { rung: 0, explanation: "" };
}

/** Live view of a browser task. The first visit to a site waits for approval. */
export class BrowserSession {
  readonly steps: string[] = [];
  stopped = false;

  private readonly seenHosts = new Set<string>();

  constructor(private readonly approvals: Approvals) {}

  async visit(url: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    const host = new URL(url).host;
    if (!this.seenHosts.has(host)) {
      await new Promise<void>((resolve) => {
        void this.approvals.runTask("browser", async (task) => {
          await task.request({
            summary: `visit ${host}`,
            draft: url,
            capability: "browser.visit",
          });
          resolve();
        });
      });
      this.seenHosts.add(host);
    }
    this.steps.push(`open ${url}`);
  }

  runScript(pageSteps: string[]): void {
    for (const step of pageSteps) {
      if (this.stopped) {
        return;
      }
      this.steps.push(step);
    }
  }

  stop(): number {
    const started = Date.now();
    this.stopped = true;
    return Date.now() - started;
  }

  liveView(): string[] {
    return [...this.steps];
  }
}
