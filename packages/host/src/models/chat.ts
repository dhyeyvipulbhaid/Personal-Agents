import type { Approvals } from "../approvals/approvals.ts";
import type {
  ChatResult,
  ChatTurn,
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
      runTool: (call: ToolCall, signal?: AbortSignal) => Promise<string>;
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
    const messages: ChatTurn[] = [
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
      let handled = false;
      let toolOutput = "";
      if (call && tools && known) {
        handled = true;
        toolOutput = await tools.runTool(call, controller.signal);
        if (
          controller.signal.aborted ||
          toolOutput.includes('"cancelled":true')
        ) {
          if (assistant.text.trim().length === 0) {
            assistant.text = "Stopped.";
          }
          return { text: assistant.text };
        }
        messages.push({
          role: "assistant",
          content: result.text,
          toolCalls: [
            {
              function: {
                name: call.name,
                arguments: parsedArguments(call.arguments),
              },
            },
          ],
        });
        messages.push({
          role: "tool",
          content: toolOutput,
          toolName: call.name,
        });
        assistant.text = "";
        try {
          result = await this.adapter.chat(
            { model, messages },
            onDelta,
            controller.signal,
          );
        } catch (error) {
          const detail = error instanceof Error ? error.message : "unknown";
          console.error(`chat-tool ${call.name} follow-up failed: ${detail}`);
          throw error;
        }
        console.error(
          `chat-tool ${call.name} follow-up chars=${result.text.length} tool=${result.toolCall?.name ?? "none"}`,
        );
      }
      if (result.text.trim().length > 0) {
        assistant.text = result.text;
      } else if (handled) {
        assistant.text = replyFromTool(toolOutput);
      }
      if (result.toolCall && !handled) {
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
    this.markApproval(id, "(approved)");
  }

  denyInline(id: string): void {
    this.approvals.deny(id);
    this.markApproval(id, "(denied)");
  }

  private markApproval(id: string, mark: string): void {
    const entry = this.messages.find((item) => item.approvalId === id);
    if (entry && !entry.text.includes(mark)) {
      entry.text = `${entry.text} ${mark}`;
    }
  }
}

function parsedArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

function replyFromTool(output: string): string {
  try {
    const parsed = JSON.parse(output) as { opened?: boolean; title?: string };
    if (parsed.opened === false) {
      return "That visit was not allowed.";
    }
    if (typeof parsed.title === "string" && parsed.title.length > 0) {
      return `The page title is ${parsed.title}.`;
    }
  } catch {
    // The tool result is plain text.
  }
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return "The model did not answer.";
  }
  return trimmed;
}
