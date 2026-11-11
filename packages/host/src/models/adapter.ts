export type ModelCapabilities = {
  name: string;
  tools: boolean;
  streaming: boolean;
  structured: boolean;
};

export type ChatTurn = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ChatRequest = {
  model: string;
  messages: ChatTurn[];
  tools?: boolean;
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
  ): Promise<ChatResult>;
  structured<T>(request: ChatRequest): Promise<T>;
}

export type RoleName = "chat" | "agent" | "builder";

/** Per-role model choice. The agent role requires tool support. */
export class ModelSettings {
  private readonly chosen: Record<RoleName, string> = {
    chat: "",
    agent: "",
    builder: "",
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
