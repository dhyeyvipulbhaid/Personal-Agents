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
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(ollamaMessage),
        stream: true,
        tools: request.tools,
      }),
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
    return parseChatStream(text, onDelta, request.model);
  }

  async structured<T>(request: ChatRequest): Promise<T> {
    const response = await this.http(`${this.origin}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: false,
        format: request.schema,
      }),
    });
    const body = (await response.json()) as {
      message?: { content?: string };
    };
    return JSON.parse(body.message?.content ?? "{}") as T;
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

function parseChatStream(
  text: string,
  onDelta: (delta: { token: string }) => void,
  model: string,
): ChatResult {
  let assembled = "";
  let toolCall: ChatResult["toolCall"];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    const chunk = JSON.parse(line) as {
      error?: string;
      message?: {
        content?: string;
        tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
      };
    };
    if (chunk.error) {
      throw new Error(explainOllama(model, chunk.error));
    }
    const token = chunk.message?.content ?? "";
    if (token.length > 0) {
      assembled += token;
      onDelta({ token });
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
  return { text: assembled, toolCall };
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
