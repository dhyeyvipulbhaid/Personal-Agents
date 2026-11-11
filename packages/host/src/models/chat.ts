import type { Approvals } from "../approvals/approvals.ts";
import type { ChatResult, ModelAdapter, ModelSettings } from "./adapter.ts";

export type TranscriptEntry = {
  role: "user" | "assistant" | "approval";
  text: string;
  approvalId?: string;
};

/** One conversation. It reads the chat model when each message is sent. */
export class ChatSession {
  readonly messages: TranscriptEntry[] = [];
  modelsUsed: string[] = [];
  firstTokenMs: number | null = null;

  constructor(
    private readonly adapter: ModelAdapter,
    private readonly settings: ModelSettings,
    private readonly approvals: Approvals,
    private readonly clock: () => number = Date.now,
  ) {}

  async send(text: string): Promise<ChatResult> {
    this.messages.push({ role: "user", text });
    const model = this.settings.get("chat");
    this.modelsUsed.push(model);
    const started = this.clock();
    let sawToken = false;
    const result = await this.adapter.chat(
      {
        model,
        messages: this.turns(),
      },
      () => {
        if (!sawToken) {
          this.firstTokenMs = this.clock() - started;
          sawToken = true;
        }
      },
    );
    this.messages.push({ role: "assistant", text: result.text });
    if (result.toolCall) {
      this.raiseApproval(result.toolCall.name, result.toolCall.arguments);
    }
    return result;
  }

  private turns(): { role: "user" | "assistant"; content: string }[] {
    const turns: { role: "user" | "assistant"; content: string }[] = [];
    for (const entry of this.messages) {
      if (entry.role === "user" || entry.role === "assistant") {
        turns.push({ role: entry.role, content: entry.text });
      }
    }
    return turns;
  }

  raiseApproval(summary: string, draft: string): string {
    void this.approvals.runTask("chat", async (task) => {
      await task.request({
        summary,
        draft,
        capability: "files.delete",
        effects: ["deletes"],
      });
    });
    const item = this.approvals.pending().at(-1);
    const id = item?.id ?? "";
    this.messages.push({
      role: "approval",
      text: summary,
      approvalId: id,
    });
    return id;
  }

  approveInline(id: string): void {
    this.approvals.approve(id);
    const entry = this.messages.find((item) => item.approvalId === id);
    if (entry) {
      entry.text = `${entry.text} (approved)`;
    }
  }
}
