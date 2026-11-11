import type {
  ChatRequest,
  ChatResult,
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
    const body = (await response.json()) as {
      models?: { name?: string; capabilities?: string[] }[];
    };
    return (body.models ?? []).map((model) => {
      const capabilities = model.capabilities ?? [];
      return {
        name: model.name ?? "",
        tools: capabilities.includes("tools"),
        streaming: capabilities.includes("completion"),
        structured: capabilities.includes("structured"),
      };
    });
  }

  async chat(
    request: ChatRequest,
    onDelta: (delta: { token: string }) => void,
  ): Promise<ChatResult> {
    const response = await this.http(`${this.origin}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        tools: request.tools ? [{ type: "function" }] : undefined,
      }),
    });
    const text = await response.text();
    let assembled = "";
    let toolCall: ChatResult["toolCall"];
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      const chunk = JSON.parse(line) as {
        message?: {
          content?: string;
          tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
        };
      };
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
