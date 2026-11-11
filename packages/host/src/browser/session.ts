import type { Approvals } from "../approvals/approvals.ts";
import type { Check } from "../capabilities/probe.ts";
import { type ReadablePage, readableFromHtml } from "./read.ts";

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

export type VisitOutcome = "opened" | "denied" | "cancelled";

/** Live view of a browser task. The first visit to a site waits for approval. */
export class BrowserSession {
  readonly steps: string[] = [];
  stopped = false;

  private readonly seenHosts = new Set<string>();

  constructor(private readonly approvals: Approvals) {}

  async read(
    url: string,
    load: (url: string) => Promise<string>,
  ): Promise<
    ReadablePage & { url: string; opened: boolean; cancelled?: boolean }
  > {
    const outcome = await this.visit(url);
    if (outcome === "cancelled") {
      return {
        url,
        opened: false,
        cancelled: true,
        title: "",
        headings: [],
        text: "",
      };
    }
    if (outcome !== "opened") {
      return { url, opened: false, title: "", headings: [], text: "" };
    }
    try {
      const page = readableFromHtml(await load(url));
      return { url, opened: true, ...page };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return {
          url,
          opened: false,
          cancelled: true,
          title: "",
          headings: [],
          text: "",
        };
      }
      throw error;
    }
  }

  async visit(url: string): Promise<VisitOutcome> {
    if (this.stopped) {
      return "cancelled";
    }
    const host = new URL(url).host;
    if (!this.seenHosts.has(host)) {
      const decision = await new Promise<{ decision: string }>((resolve) => {
        void this.approvals.runTask("browser", async (task) => {
          resolve(
            await task.request({
              summary: `visit ${host}`,
              draft: url,
              capability: "browser.visit",
            }),
          );
        });
      });
      if (decision.decision === "cancelled") {
        return "cancelled";
      }
      if (decision.decision !== "approved") {
        return "denied";
      }
      this.seenHosts.add(host);
    }
    this.steps.push(`open ${url}`);
    return "opened";
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
