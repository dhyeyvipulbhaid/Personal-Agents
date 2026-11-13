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
      forced?: ToolCall;
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
      let result = tools?.forced
        ? { text: "", toolCall: tools.forced }
        : await this.adapter.chat(
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
      let forModel = "";
      if (call && tools && known) {
        handled = true;
        assistant.text = "";
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
        const refused = deniedActionReply(toolOutput);
        if (refused) {
          assistant.text = refused;
          return { text: refused };
        }
        if (call.name === "browser.navigate") {
          assistant.text = navigateReply(toolOutput);
          return { text: assistant.text };
        }
        if (
          tools?.forced?.name === "browser.read" &&
          call.name === "browser.read"
        ) {
          const read = readForAnswer(toolOutput);
          if (read.failed) {
            assistant.text = read.fallback;
            return { text: read.fallback };
          }
          result = await this.adapter.chat(
            {
              model,
              messages: [
                {
                  role: "system",
                  content: `Answer using only the page text. Include this link: ${read.url}. Do not add facts that are not in the text.`,
                },
                { role: "user", content: text },
                {
                  role: "user",
                  content: `Page text from ${read.url}:\n${read.pageText}`,
                },
              ],
            },
            onDelta,
            controller.signal,
          );
          const reply = result.text.trim();
          assistant.text = reply.includes(read.url)
            ? reply
            : `${reply}\n${read.url}`.trim();
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
        forModel = modelToolContent(toolOutput);
        messages.push({
          role: "tool",
          content: forModel,
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
        assistant.text = replyFromTool(forModel);
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

type ToolPayload = {
  opened?: boolean;
  denied?: boolean;
  cancelled?: boolean;
  url?: string;
  action?: string;
  target?: string;
  title?: string;
  text?: string;
};

function deniedActionReply(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as ToolPayload;
    if (parsed.cancelled === true) {
      return null;
    }
    if (parsed.denied !== true && parsed.opened !== false) {
      return null;
    }
    return fixedDenial(parsed);
  } catch {
    return null;
  }
}

function fixedDenial(parsed: ToolPayload): string {
  const host = hostOf(parsed.url);
  const target =
    typeof parsed.target === "string" && parsed.target.length > 0
      ? parsed.target
      : "";
  if (parsed.action === "click") {
    const label = target.length > 0 ? target : "that control";
    return host.length > 0
      ? `Not allowed: I didn't click "${label}" on ${host}.`
      : `Not allowed: I didn't click "${label}".`;
  }
  if (parsed.action === "type") {
    const field = target.length > 0 ? target : "that field";
    return host.length > 0
      ? `Not allowed: I didn't type into "${field}" on ${host}.`
      : `Not allowed: I didn't type into "${field}".`;
  }
  return `Not allowed: I didn't open ${host.length > 0 ? host : "that page"}.`;
}

function readForAnswer(output: string): {
  failed: boolean;
  fallback: string;
  url: string;
  pageText: string;
} {
  let url = "";
  try {
    const parsed = JSON.parse(output) as {
      url?: string;
      text?: string;
      title?: string;
      opened?: boolean;
    };
    url = typeof parsed.url === "string" ? parsed.url : "";
    const pageText = typeof parsed.text === "string" ? parsed.text.trim() : "";
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    if (parsed.opened === false || pageText.length === 0) {
      return {
        failed: true,
        fallback: `I couldn't read the page. ${url || "the page"}`.trim(),
        url,
        pageText: "",
      };
    }
    return {
      failed: false,
      fallback: "",
      url,
      pageText: title.length > 0 ? `${title}\n${pageText}` : pageText,
    };
  } catch {
    return {
      failed: true,
      fallback: "I couldn't read the page.",
      url,
      pageText: "",
    };
  }
}

function navigateReply(output: string): string {
  try {
    const parsed = JSON.parse(output) as { message?: string };
    if (typeof parsed.message === "string" && parsed.message.length > 0) {
      return parsed.message;
    }
  } catch {
    // The tool result is plain text.
  }
  return "Could not confirm that the page opened in Chrome.";
}

function modelToolContent(output: string): string {
  try {
    const parsed = JSON.parse(output) as ToolPayload & {
      ok?: boolean;
      message?: string;
    };
    const pageText = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (pageText.length > 0) {
      return output;
    }
    if (
      parsed.ok === true &&
      typeof parsed.message === "string" &&
      parsed.message.startsWith("Opened ")
    ) {
      const host = hostOf(parsed.url);
      return host.length > 0
        ? `Opened ${host}. No page text was returned.`
        : "Opened the page. No page text was returned.";
    }
  } catch {
    // The tool result is plain text.
  }
  return output;
}

function hostOf(url: string | undefined): string {
  if (typeof url !== "string" || url.length === 0) {
    return "";
  }
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function replyFromTool(output: string): string {
  const refused = deniedActionReply(output);
  if (refused) {
    return refused;
  }
  try {
    const parsed = JSON.parse(output) as ToolPayload;
    if (
      typeof parsed.text === "string" &&
      parsed.text.length > 0 &&
      parsed.text !== parsed.title
    ) {
      const title =
        typeof parsed.title === "string" && parsed.title.length > 0
          ? `${parsed.title}. `
          : "";
      return `${title}${parsed.text}`.slice(0, 2_000);
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
