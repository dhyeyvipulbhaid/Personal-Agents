import type {
  ChatRequest,
  ChatResult,
  ChatTurn,
  ModelAdapter,
  ModelCapabilities,
} from "./adapter.ts";

type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

/** Ollama connector. Pass a client so tests do not need a running Ollama. */
export class OllamaConnector implements ModelAdapter {
  constructor(
    private readonly http: HttpClient,
    private readonly origin = "http://127.0.0.1:11434",
  ) {}

  async listModels(): Promise<ModelCapabilities[]> {
    const response = await this.http(`${this.origin}/api/tags`);
    if (!response.ok) {
      throw new Error(
        await ollamaFailure(response, "Ollama did not list models"),
      );
    }
    const body = (await response.json()) as {
      models?: { name?: string; capabilities?: string[] }[];
    };
    const listed: ModelCapabilities[] = [];
    for (const model of body.models ?? []) {
      const name = model.name ?? "";
      let capabilities = model.capabilities;
      if ((!capabilities || capabilities.length === 0) && name.length > 0) {
        capabilities = await this.showCapabilities(name);
      }
      listed.push(capabilitiesOf(name, capabilities));
    }
    return listed;
  }

  async chat(
    request: ChatRequest,
    onDelta: (delta: { token: string }) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult> {
    const response = await this.http(`${this.origin}/api/chat`, {
      method: "POST",
      body: JSON.stringify(ollamaChatBody(request)),
      signal,
    });
    if (!response.ok) {
      throw new Error(
        await ollamaFailure(
          response,
          `Ollama returned ${response.status}`,
          request.model,
        ),
      );
    }
    const text = await readStream(response, signal);
    return parseChatStream(
      text,
      onDelta,
      request.model,
      toolNames(request.tools),
    );
  }

  async structured<T>(request: ChatRequest): Promise<T> {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      stream: false,
      format: request.schema,
    };
    if (/qwen3/i.test(request.model)) {
      payload.think = false;
    }
    const response = await this.http(`${this.origin}/api/chat`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as {
      message?: { content?: string };
    };
    return JSON.parse(stripThink(body.message?.content ?? "")) as T;
  }

  private async showCapabilities(name: string): Promise<string[] | undefined> {
    try {
      const response = await this.http(`${this.origin}/api/show`, {
        method: "POST",
        body: JSON.stringify({ model: name }),
      });
      if (!response.ok) {
        return undefined;
      }
      const body = (await response.json()) as { capabilities?: string[] };
      return body.capabilities;
    } catch {
      return undefined;
    }
  }
}

function ollamaChatBody(request: ChatRequest): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(ollamaMessage),
    stream: true,
    tools: request.tools,
  };
  if (/qwen3/i.test(request.model)) {
    body.think = false;
  }
  return body;
}

function ollamaMessage(message: ChatTurn): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    role: message.role,
    content: message.content,
  };
  if (message.toolCalls && message.toolCalls.length > 0) {
    payload.tool_calls = message.toolCalls.map((call) => ({
      type: "function",
      function: {
        name: call.function.name,
        arguments: call.function.arguments,
      },
    }));
  }
  if (message.toolName) {
    payload.name = message.toolName;
  }
  return payload;
}

function capabilitiesOf(
  name: string,
  capabilities: string[] | undefined,
): ModelCapabilities {
  if (capabilities && capabilities.length > 0) {
    return {
      name,
      tools: capabilities.includes("tools"),
      streaming: capabilities.includes("completion"),
      structured: capabilities.includes("structured"),
    };
  }
  return { name, tools: true, streaming: true, structured: true };
}

async function readStream(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return response.text();
  }
  if (signal?.aborted) {
    await reader.cancel().catch(() => {});
    throw new DOMException("The operation was aborted.", "AbortError");
  }
  const decoder = new TextDecoder();
  let text = "";
  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      if (done) {
        return text + decoder.decode();
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

function toolNames(tools: ChatRequest["tools"]): Set<string> {
  return new Set(
    (tools ?? [])
      .map((tool) => tool.function.name)
      .filter((name) => name.length > 0),
  );
}

/** Drops model reasoning so it never reaches the chat bubble or history. */
export function stripThink(text: string): string {
  let result = text;
  let changed = false;
  for (;;) {
    const next = result
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
      .replace(/<think\b[^>]*>[\s\S]*$/i, "");
    if (next === result) {
      break;
    }
    result = next;
    changed = true;
  }
  const orphan = /<\/think>/i.exec(result);
  if (orphan) {
    result = result.slice(orphan.index + orphan[0].length);
    changed = true;
  }
  if (!changed) {
    return result;
  }
  return result.replace(/^\s+/, "");
}

function textToolCall(
  content: string,
  names: Set<string>,
): ChatResult["toolCall"] | undefined {
  let text = content.trim();
  if (text.length === 0 || names.size === 0) {
    return undefined;
  }
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence?.[1]) {
    text = fence[1].trim();
  }
  const tagged = /^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i.exec(text);
  if (tagged?.[1]) {
    text = tagged[1].trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as { name?: unknown; arguments?: unknown };
  if (typeof record.name !== "string" || !names.has(record.name)) {
    return undefined;
  }
  const args = record.arguments;
  return {
    name: record.name,
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
  };
}

function mightHold(content: string): boolean {
  const trimmed = content.trimStart();
  return (
    trimmed.startsWith("{") ||
    trimmed.startsWith("```") ||
    /^<tool_call>/i.test(trimmed) ||
    /<think\b/i.test(content) ||
    /<\/think>/i.test(content)
  );
}

function parseChatStream(
  text: string,
  onDelta: (delta: { token: string }) => void,
  model: string,
  names: Set<string>,
): ChatResult {
  let raw = "";
  let emitted = "";
  let toolCall: ChatResult["toolCall"];
  const defer = /qwen3/i.test(model);
  const emitVisible = (final: boolean) => {
    const visible = stripThink(raw);
    if (textToolCall(visible, names)) {
      return;
    }
    if (!final && (defer || mightHold(raw))) {
      return;
    }
    if (!visible.startsWith(emitted)) {
      return;
    }
    const delta = visible.slice(emitted.length);
    if (delta.length === 0) {
      return;
    }
    onDelta({ token: delta });
    emitted = visible;
  };
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const chunk = JSON.parse(line) as {
      error?: string;
      message?: {
        content?: string;
        thinking?: string;
        tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
      };
    };
    if (chunk.error) {
      throw new Error(explainOllama(model, chunk.error));
    }
    const token = chunk.message?.content ?? "";
    if (token.length > 0) {
      raw += token;
      emitVisible(false);
    }
    const call = chunk.message?.tool_calls?.[0]?.function;
    if (call?.name) {
      toolCall = {
        name: call.name,
        arguments:
          typeof call.arguments === "string"
            ? call.arguments
            : JSON.stringify(call.arguments ?? {}),
      };
    }
  }
  const visible = stripThink(raw);
  const fromText = textToolCall(visible, names);
  if (!toolCall && fromText) {
    toolCall = fromText;
  }
  if (fromText) {
    return { text: "", toolCall };
  }
  emitVisible(true);
  return { text: stripThink(raw), toolCall };
}

async function ollamaFailure(
  response: Response,
  fallback: string,
  model?: string,
): Promise<string> {
  let detail = fallback;
  try {
    detail = (await response.text()) || fallback;
  } catch {
    detail = fallback;
  }
  return explainOllama(model ?? "", detail);
}

export function explainOllama(model: string, detail: string): string {
  if (
    /not found|does not exist|try pulling/i.test(detail) &&
    model.length > 0
  ) {
    return `${model} is not installed. Run \`ollama pull ${model}\`.`;
  }
  return detail;
}

export const OLLAMA_PLUGIN_SOURCE = `
export const manifest = {
  id: "ollama",
  name: "Ollama",
  version: "0.0.0",
  minCoreVersion: "0.0.0",
  effects: ["connector"]
};
export function apply(ctx) {
  ctx.register({ effect: "connector", id: "ollama" });
}
`;
