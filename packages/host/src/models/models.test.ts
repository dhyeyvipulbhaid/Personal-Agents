import { expect, test } from "bun:test";
import { Approvals } from "../approvals/approvals.ts";
import { PluginKernel } from "../plugins/kernel.ts";
import {
  type ChatRequest,
  type ModelAdapter,
  ModelSettings,
} from "./adapter.ts";
import { ChatSession } from "./chat.ts";
import { OLLAMA_PLUGIN_SOURCE, OllamaConnector } from "./ollama.ts";

const withTools = {
  name: "llama",
  tools: true,
  streaming: true,
  structured: true,
};
const withoutTools = {
  name: "plain",
  tools: false,
  streaming: true,
  structured: false,
};

test("the ollama connector reads reported capabilities", async () => {
  const connector = new OllamaConnector(async (url) => {
    expect(url).toBe("http://127.0.0.1:11434/api/tags");
    return Response.json({
      models: [
        { name: "llama", capabilities: ["completion", "tools", "structured"] },
        { name: "plain", capabilities: ["completion"] },
      ],
    });
  });

  expect(await connector.listModels()).toEqual([withTools, withoutTools]);
});

test("the ollama connector streams tokens and reads a tool call", async () => {
  const connector = new OllamaConnector(async () => {
    return new Response(
      [
        JSON.stringify({ message: { content: "Hi" }, done: false }),
        JSON.stringify({
          message: {
            content: " there",
            tool_calls: [
              { function: { name: "delete_row", arguments: { id: 1 } } },
            ],
          },
          done: true,
        }),
      ].join("\n"),
    );
  });
  const tokens: string[] = [];
  const result = await connector.chat(
    { model: "llama", messages: [{ role: "user", content: "go" }] },
    (delta) => tokens.push(delta.token),
  );

  expect(tokens).toEqual(["Hi", " there"]);
  expect(result.text).toBe("Hi there");
  expect(result.toolCall).toEqual({
    name: "delete_row",
    arguments: JSON.stringify({ id: 1 }),
  });
});

test("the ollama connector returns structured output", async () => {
  const connector = new OllamaConnector(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as {
      format?: { type?: string };
    };
    expect(body.format).toEqual({ type: "object" });
    return Response.json({
      message: { content: JSON.stringify({ total: 3 }) },
    });
  });

  expect(
    await connector.structured<{ total: number }>({
      model: "llama",
      messages: [{ role: "user", content: "total" }],
      schema: { type: "object" },
    }),
  ).toEqual({ total: 3 });
});

test("v1 defaults are qwen3:4b, qwen3:8b, and qwen2.5-coder:7b", () => {
  const settings = new ModelSettings();
  expect(settings.get("chat")).toBe("qwen3:4b");
  expect(settings.get("agent")).toBe("qwen3:8b");
  expect(settings.get("builder")).toBe("qwen2.5-coder:7b");
});

test("a missing ollama model tells you the pull command", async () => {
  const connector = new OllamaConnector(async () => {
    return new Response(
      JSON.stringify({ error: "model 'qwen3:4b' not found" }),
      {
        status: 404,
      },
    );
  });
  await expect(
    connector.chat(
      { model: "qwen3:4b", messages: [{ role: "user", content: "hi" }] },
      () => {},
    ),
  ).rejects.toThrow("ollama pull qwen3:4b");
});

test("tags without capabilities fall back to /api/show", async () => {
  const connector = new OllamaConnector(async (url) => {
    if (url.endsWith("/api/tags")) {
      return Response.json({ models: [{ name: "qwen3:4b" }] });
    }
    return Response.json({ capabilities: ["completion", "tools"] });
  });
  expect(await connector.listModels()).toEqual([
    {
      name: "qwen3:4b",
      tools: true,
      streaming: true,
      structured: false,
    },
  ]);
});

test("a model without tool support cannot be the agent model", () => {
  const settings = new ModelSettings();
  settings.set("chat", "plain", [withTools, withoutTools]);
  expect(() =>
    settings.set("agent", "plain", [withTools, withoutTools]),
  ).toThrow(/tool/);
  settings.set("agent", "llama", [withTools, withoutTools]);
  expect(settings.get("agent")).toBe("llama");
});

test("changing the chat model takes effect on the next message", async () => {
  const seen: string[] = [];
  const adapter: ModelAdapter = {
    async listModels() {
      return [withTools];
    },
    async chat(request: ChatRequest) {
      seen.push(request.model);
      return { text: `from ${request.model}` };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const settings = new ModelSettings();
  settings.set("chat", "llama", [withTools]);
  const session = new ChatSession(adapter, settings, new Approvals(() => {}));
  await session.send("one");
  settings.set("chat", "llama-next", [{ ...withTools, name: "llama-next" }]);
  await session.send("two");

  expect(seen).toEqual(["llama", "llama-next"]);
  expect(session.messages.map((entry) => entry.text)).toContain(
    "from llama-next",
  );
});

test("a streamed reply records the first token and an inline approval clears the queue", async () => {
  let now = 10;
  const adapter: ModelAdapter = {
    async listModels() {
      return [withTools];
    },
    async chat(_request, onDelta) {
      now = 25;
      onDelta({ token: "Ok" });
      return {
        text: "Ok",
        toolCall: { name: "delete the row", arguments: "delete row 1" },
      };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const approvals = new Approvals(() => {});
  const settings = new ModelSettings();
  settings.set("chat", "llama", [withTools]);
  const session = new ChatSession(adapter, settings, approvals, () => now);
  await session.send("please");

  expect(session.firstTokenMs).toBe(15);
  const id =
    session.messages.find((entry) => entry.role === "approval")?.approvalId ??
    "";
  expect(approvals.pending().map((item) => item.id)).toEqual([id]);
  session.approveInline(id);
  expect(approvals.pending()).toEqual([]);
  expect(
    session.messages.some((entry) => entry.text.includes("(approved)")),
  ).toBe(true);
});

test("unloading the ollama plugin leaves zero registrations", async () => {
  const kernel = new PluginKernel();
  await kernel.load(OLLAMA_PLUGIN_SOURCE);
  expect(kernel.registrations().map((item) => item.effect)).toEqual([
    "connector",
  ]);
  kernel.unload("ollama");
  expect(kernel.registrations()).toEqual([]);
});
