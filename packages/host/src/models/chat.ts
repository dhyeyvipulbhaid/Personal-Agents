import type { Approvals } from "../approvals/approvals.ts";
import type {
  ChatResult,
  ModelAdapter,
  ModelSettings,
  ToolCall,
  ToolDefinition,
} from "./adapter.ts";

export type TranscriptEntry = {
  role: "user" | "assistant" | "approval" | "memory";
  text: string;
  approvalId?: string;
};

/** One conversation. It reads the chat model when each message is sent. */
export class ChatSession {
  readonly messages: TranscriptEntry[] = [];
  modelsUsed: string[] = [];
  firstTokenMs: number | null = null;
  private abort: AbortController | null = null;

  constructor(
    private readonly adapter: ModelAdapter,
    private readonly settings: ModelSettings,
    private readonly approvals: Approvals,
    private readonly clock: () => number = Date.now,
  ) {}

  stop(): void {
    this.abort?.abort();
  }

  async send(
    text: string,
    context?: string,
    tools?: {
      model?: string;
      definitions: ToolDefinition[];
      runTool: (call: ToolCall) => Promise<string>;
    },
  ): Promise<ChatResult> {
    this.messages.push({ role: "user", text });
    const model = tools?.model || this.settings.get("chat");
    this.modelsUsed.push(model);
    const history = this.turns();
    const assistant: TranscriptEntry = { role: "assistant", text: "" };
    this.messages.push(assistant);
    const started = this.clock();
    let sawToken = false;
    const controller = new AbortController();
    this.abort = controller;
    const messages = [
      ...(context ? [{ role: "system" as const, content: context }] : []),
      ...history,
    ];
    const onDelta = (delta: { token: string }) => {
      if (!sawToken) {
        this.firstTokenMs = this.clock() - started;
        sawToken = true;
      }
      assistant.text += delta.token;
    };
    try {
      let result = await this.adapter.chat(
        {
          model,
          messages,
          tools: tools?.definitions,
        },
        onDelta,
        controller.signal,
      );
      const call = result.toolCall;
      const known =
        call !== undefined &&
        tools?.definitions.some((item) => item.function.name === call.name) ===
          true;
      if (call && tools && known) {
        const output = await tools.runTool(call);
        messages.push({
          role: "user",
          content: `Tool result for ${call.name}:\n${output}`,
        });
        result = await this.adapter.chat(
          { model, messages, tools: tools.definitions },
          onDelta,
          controller.signal,
        );
      }
      if (result.text) {
        assistant.text = result.text;
      }
      if (result.toolCall) {
        this.raiseApproval(result.toolCall.name, result.toolCall.arguments);
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted) {
        if (assistant.text.length === 0) {
          assistant.text = "Stopped.";
        }
        return { text: assistant.text };
      }
      const message =
        error instanceof Error ? error.message : "The model did not answer.";
      assistant.text = message;
      throw error;
    } finally {
      if (this.abort === controller) {
        this.abort = null;
      }
    }
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
