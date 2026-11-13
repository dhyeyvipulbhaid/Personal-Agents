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

test("qwen3 tool selection disables thinking", async () => {
  const bodies: { model?: string; think?: boolean; tools?: unknown }[] = [];
  const connector = new OllamaConnector(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({ message: { content: "ok" }, done: true }),
    );
  });
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "browser.read",
        description: "Read a page.",
        parameters: {},
      },
    },
  ];
  const messages = [{ role: "user" as const, content: "open example.com" }];
  await connector.chat({ model: "qwen3:8b", messages, tools }, () => {});
  await connector.chat({ model: "qwen3:4b", messages }, () => {});
  await connector.chat({ model: "llama", messages, tools }, () => {});
  expect(bodies[0]?.think).toBe(false);
  expect(bodies[0]?.tools).toBeDefined();
  expect(bodies[1]?.think).toBe(false);
  expect(bodies[2]?.think).toBeUndefined();
});

test("the thinking field and a think block are not shown", async () => {
  const tokens: string[] = [];
  const connector = new OllamaConnector(async () => {
    return new Response(
      [
        JSON.stringify({
          message: { thinking: "plan the click", content: "" },
        }),
        JSON.stringify({
          message: {
            content:
              "<think>Okay, the user wants me to navigate.</think>The page title is Example Domain.",
          },
          done: true,
        }),
      ].join("\n"),
    );
  });
  const result = await connector.chat(
    {
      model: "qwen3:4b",
      messages: [{ role: "user", content: "open example.com" }],
    },
    (delta) => tokens.push(delta.token),
  );
  expect(result.text).toBe("The page title is Example Domain.");
  expect(tokens.join("")).toBe(result.text);
  expect(tokens.join("")).not.toContain("Okay");
  expect(tokens.join("")).not.toContain("plan the click");
});

test("an orphan think close tag is stripped", async () => {
  const tokens: string[] = [];
  const connector = new OllamaConnector(async () => {
    return new Response(
      JSON.stringify({
        message: {
          content:
            "Okay, the user wants me to navigate.</think>The page says hello.",
        },
        done: true,
      }),
    );
  });
  const result = await connector.chat(
    {
      model: "qwen3:4b",
      messages: [{ role: "user", content: "open example.com" }],
    },
    (delta) => tokens.push(delta.token),
  );
  expect(result.text).toBe("The page says hello.");
  expect(tokens.join("")).toBe("The page says hello.");
});

test("a tool call written as plain text is invoked and not shown", async () => {
  const tokens: string[] = [];
  const raw =
    '{"name": "browser.navigate", "arguments": {"url": "https://www.wikipedia.org"}}';
  const connector = new OllamaConnector(async () => {
    return new Response(
      JSON.stringify({ message: { content: raw }, done: true }),
    );
  });
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "browser.navigate",
        description: "Open a URL.",
        parameters: {},
      },
    },
  ];
  const result = await connector.chat(
    {
      model: "qwen2.5-coder:7b",
      messages: [{ role: "user", content: "open wikipedia" }],
      tools,
    },
    (delta) => tokens.push(delta.token),
  );
  expect(result.toolCall).toEqual({
    name: "browser.navigate",
    arguments: JSON.stringify({ url: "https://www.wikipedia.org" }),
  });
  expect(result.text).toBe("");
  expect(tokens).toEqual([]);
});

test("ordinary text is left unchanged", async () => {
  const connector = new OllamaConnector(async () => {
    return new Response(
      JSON.stringify({
        message: { content: "The page title is Example Domain." },
        done: true,
      }),
    );
  });
  const result = await connector.chat(
    {
      model: "qwen3:4b",
      messages: [{ role: "user", content: "hi" }],
    },
    () => {},
  );
  expect(result.text).toBe("The page title is Example Domain.");
  expect(result.toolCall).toBeUndefined();
});

test("aborting the signal cancels a stalled ollama stream", async () => {
  let sent = false;
  const connector = new OllamaConnector(async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({ message: { content: "Hi" } })}\n`,
            ),
          );
          return;
        }
        await new Promise(() => {});
      },
    });
    return new Response(stream);
  });
  const controller = new AbortController();
  const pending = connector.chat(
    { model: "qwen3:8b", messages: [{ role: "user", content: "hi" }] },
    () => {},
    controller.signal,
  );
  await Bun.sleep(20);
  controller.abort();
  const outcome = await Promise.race([
    pending.then(
      () => "finished",
      () => "aborted",
    ),
    Bun.sleep(400).then(() => "hung"),
  ]);
  expect(outcome).toBe("aborted");
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

test("a navigate result without page text does not describe the page", async () => {
  const seen: string[] = [];
  const adapter: ModelAdapter = {
    async listModels() {
      return [withTools];
    },
    async chat(request) {
      const tool = request.messages.find((message) => message.role === "tool");
      if (tool) {
        seen.push(tool.content);
      }
      if (
        request.tools?.some((item) => item.function.name === "browser.navigate")
      ) {
        return {
          text: "",
          toolCall: {
            name: "browser.navigate",
            arguments: JSON.stringify({ url: "https://apple.com/" }),
          },
        };
      }
      return { text: "Opened apple.com." };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const settings = new ModelSettings();
  settings.set("chat", "llama", [withTools]);
  const session = new ChatSession(adapter, settings, new Approvals(() => {}));
  await session.send("open apple.com", undefined, {
    definitions: [
      {
        type: "function",
        function: {
          name: "browser.navigate",
          description: "Open a URL in Chrome.",
          parameters: {},
        },
      },
    ],
    runTool: async () =>
      JSON.stringify({
        ok: true,
        allowed: true,
        url: "https://apple.com/",
        message: "Opened apple.com in Chrome.",
      }),
  });
  expect(seen).toEqual([]);
  expect(session.messages.at(-1)?.text).toBe("Opened apple.com in Chrome.");
  expect(session.messages.at(-1)?.text).not.toContain("iPhone");
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

test("think-only and blank tokens stay hidden until visible text", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter: ModelAdapter = {
    async listModels() {
      return [{ ...withTools, name: "qwen3:4b" }];
    },
    async chat(_request, onDelta) {
      onDelta({ token: "" });
      onDelta({ token: "   " });
      onDelta({ token: "<think>planning the summary</think>" });
      await gate;
      onDelta({ token: "A short summary." });
      return { text: "A short summary." };
    },
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const settings = new ModelSettings();
  settings.set("chat", "qwen3:4b", [{ ...withTools, name: "qwen3:4b" }]);
  const session = new ChatSession(adapter, settings, new Approvals(() => {}));
  const pending = session.send("hello");
  await Bun.sleep(30);
  const assistant = session.messages.find(
    (entry) => entry.role === "assistant",
  );
  expect(assistant?.text ?? "").toBe("");
  release();
  await pending;
  expect(assistant?.text).toBe("A short summary.");
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
