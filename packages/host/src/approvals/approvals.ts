export type ActivityEntry = {
  at: string;
  summary: string;
  decision: string;
};

export type ApprovalDecision = {
  decision: "approved" | "denied" | "more-info";
  draft: string;
  instruction: string;
};

export type ApprovalItem = {
  id: string;
  taskId: string;
  summary: string;
  draft: string;
  capability: string;
  status: "pending" | "snoozed";
  snoozeUntil?: number;
};

type RequestInput = {
  summary: string;
  draft: string;
  capability: string;
  effects?: string[];
};

type TaskContext = {
  request: (input: RequestInput) => Promise<ApprovalDecision>;
};

type Waiting = {
  item: ApprovalItem;
  resolve: (decision: ApprovalDecision) => void;
};

/** Pauses one task on a request without stopping other tasks. */
export class Approvals {
  private nextId = 0;
  private readonly waiting = new Map<string, Waiting>();
  private readonly taskAllows = new Set<string>();
  private readonly clock: () => number;
  private readonly audit: (entry: ActivityEntry) => void;

  constructor(
    audit: (entry: ActivityEntry) => void,
    clock: () => number = Date.now,
  ) {
    this.audit = audit;
    this.clock = clock;
  }

  runTask<T>(
    taskId: string,
    fn: (task: TaskContext) => Promise<T>,
  ): Promise<T> {
    return fn({
      request: (input) => this.request(taskId, input),
    });
  }

  pending(): ApprovalItem[] {
    this.tick();
    return [...this.waiting.values()]
      .map((entry) => entry.item)
      .filter((item) => item.status === "pending");
  }

  snoozed(): ApprovalItem[] {
    return [...this.waiting.values()]
      .map((entry) => entry.item)
      .filter((item) => item.status === "snoozed");
  }

  approve(id: string, scope: "once" | "task" = "once"): void {
    const entry = this.require(id);
    if (scope === "task") {
      this.taskAllows.add(`${entry.item.taskId}:${entry.item.capability}`);
    }
    this.finish(entry, {
      decision: "approved",
      draft: entry.item.draft,
      instruction: "",
    });
    this.log(`${entry.item.taskId} approved`, "approved");
  }

  deny(id: string): void {
    const entry = this.require(id);
    this.finish(entry, {
      decision: "denied",
      draft: entry.item.draft,
      instruction: "",
    });
    this.log(`${entry.item.taskId} denied`, "denied");
  }

  moreInfo(id: string, instruction: string): void {
    const entry = this.require(id);
    this.finish(entry, {
      decision: "more-info",
      draft: entry.item.draft,
      instruction,
    });
    this.log(`${entry.item.taskId} more-info: ${instruction}`, "more-info");
  }

  edit(id: string, draft: string): void {
    const entry = this.require(id);
    entry.item = { ...entry.item, draft };
    this.log(`${entry.item.taskId} edited: ${draft}`, "edited");
  }

  snooze(id: string, until: number): void {
    const entry = this.require(id);
    entry.item = { ...entry.item, status: "snoozed", snoozeUntil: until };
    this.log(`${entry.item.taskId} snoozed`, "snoozed");
  }

  tick(): void {
    const now = this.clock();
    for (const entry of this.waiting.values()) {
      if (
        entry.item.status === "snoozed" &&
        entry.item.snoozeUntil !== undefined &&
        entry.item.snoozeUntil <= now
      ) {
        entry.item = { ...entry.item, status: "pending" };
        this.log(`${entry.item.taskId} snooze returned`, "pending");
      }
    }
  }

  private request(
    taskId: string,
    input: RequestInput,
  ): Promise<ApprovalDecision> {
    if (this.taskAllows.has(`${taskId}:${input.capability}`)) {
      this.log(`${taskId} approved for this task`, "approved");
      return Promise.resolve({
        decision: "approved",
        draft: input.draft,
        instruction: "",
      });
    }
    this.nextId += 1;
    const id = `req-${this.nextId}`;
    this.log(`${taskId} waiting: ${input.summary}`, "pending");
    return new Promise((resolve) => {
      this.waiting.set(id, {
        resolve,
        item: {
          id,
          taskId,
          summary: input.summary,
          draft: input.draft,
          capability: input.capability,
          status: "pending",
        },
      });
    });
  }

  private require(id: string): Waiting {
    const entry = this.waiting.get(id);
    if (!entry) {
      throw new Error("approval is not waiting");
    }
    return entry;
  }

  private finish(entry: Waiting, decision: ApprovalDecision): void {
    this.waiting.delete(entry.item.id);
    entry.resolve(decision);
  }

  private log(summary: string, decision: string): void {
    this.audit({
      at: new Date(this.clock()).toISOString(),
      summary,
      decision,
    });
  }
}

type PluginConfig = Record<string, string>;

/** Applies a config only after approval, and restores it if startup fails. */
export class PluginConfigs {
  private currentConfig: PluginConfig = {};

  constructor(
    private readonly approvals: Approvals,
    private readonly start: (config: PluginConfig) => Promise<void>,
    private readonly audit: (entry: ActivityEntry) => void,
  ) {}

  current(): PluginConfig {
    return { ...this.currentConfig };
  }

  setCurrent(config: PluginConfig): void {
    this.currentConfig = { ...config };
  }

  propose(pluginId: string, next: PluginConfig): Promise<void> {
    return this.approvals.runTask(`config-${pluginId}`, async (task) => {
      const result = await task.request({
        summary: `config ${pluginId}`,
        draft: JSON.stringify(next),
        capability: "plugin.config",
      });
      if (result.decision !== "approved") {
        return;
      }
      const previous = this.currentConfig;
      let parsed: PluginConfig;
      try {
        parsed = JSON.parse(result.draft) as PluginConfig;
      } catch {
        this.audit({
          at: new Date().toISOString(),
          summary: `config ${pluginId} rolled back`,
          decision: "rolled-back",
        });
        return;
      }
      try {
        await this.start(parsed);
        this.currentConfig = parsed;
      } catch {
        this.currentConfig = previous;
        this.audit({
          at: new Date().toISOString(),
          summary: `config ${pluginId} rolled back`,
          decision: "rolled-back",
        });
      }
    });
  }
}
