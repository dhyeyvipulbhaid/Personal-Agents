export type ModelCapabilities = {
  name: string;
  tools: boolean;
  streaming: boolean;
  structured: boolean;
};

export type ChatTurn = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: {
    function: { name: string; arguments: unknown };
  }[];
  toolName?: string;
};

export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatRequest = {
  model: string;
  messages: ChatTurn[];
  tools?: ToolDefinition[];
  schema?: unknown;
};

export type ToolCall = {
  name: string;
  arguments: string;
};

export type ChatResult = {
  text: string;
  toolCall?: ToolCall;
};

export type ChatDelta = {
  token: string;
};

/** What every model connector implements. Tests use a stand-in behind this. */
export interface ModelAdapter {
  listModels(): Promise<ModelCapabilities[]>;
  chat(
    request: ChatRequest,
    onDelta: (delta: ChatDelta) => void,
    signal?: AbortSignal,
  ): Promise<ChatResult>;
  structured<T>(request: ChatRequest): Promise<T>;
}

export type RoleName = "chat" | "agent" | "builder";

/** Per-role model choice. The agent role requires tool support. */
export class ModelSettings {
  private readonly chosen: Record<RoleName, string> = {
    chat: "qwen3:4b",
    agent: "qwen3:8b",
    builder: "qwen2.5-coder:7b",
  };

  set(role: RoleName, name: string, catalog: ModelCapabilities[]): void {
    const model = catalog.find((item) => item.name === name);
    if (!model) {
      throw new Error("unknown model");
    }
    if (role === "agent" && !model.tools) {
      throw new Error("agent model must support tools");
    }
    this.chosen[role] = name;
  }

  get(role: RoleName): string {
    return this.chosen[role];
  }
}
