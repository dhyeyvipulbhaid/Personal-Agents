import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_REVENUE_CSV } from "./data/demo.ts";
import { DesktopApp } from "./desktop.ts";
import { revenueTotal } from "./files/revenue.ts";
import { rowsFromCsv } from "./files/table.ts";
import type { ChatRequest, ModelAdapter } from "./models/adapter.ts";
import { OllamaConnector } from "./models/ollama.ts";

test("the sample revenue file ships with the app and totals 220", () => {
  const text = readFileSync(
    new URL("../fixtures/revenue/revenue.csv", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  expect(text).toBe(SAMPLE_REVENUE_CSV);
  expect(revenueTotal(rowsFromCsv(text))).toBe(220);
});

test("a fresh host serves revenue, mail, and capabilities without an unavailable state", async () => {
  const { app, methods } = await harness();
  try {
    const revenue = JSON.parse(await methods.revenue_status({})) as {
      total: number;
      line: string;
    };
    expect(revenue.total).toBe(220);
    expect(revenue.line).toContain("health ok");
    expect(JSON.stringify(revenue).toLowerCase()).not.toContain("unavailable");

    const mail = JSON.parse(await methods.mail_state({})) as {
      count: number;
      digest: string[];
      followUps: string[];
    };
    expect(mail.count).toBe(30);
    expect(mail.digest).toEqual(["Budget notes", "Desk request", "Lunch"]);
    expect(mail.followUps).toEqual([
      "North contract",
      "Q4 plan",
      "West renewal",
    ]);

    const report = JSON.parse(await methods.capabilities({})) as {
      checks: { name: string; status: string; cause: string; advice: string }[];
      plugins: { name: string; health: string; summary: string }[];
    };
    const ollama = report.checks.find((check) => check.name === "ollama");
    expect(ollama?.status).toBe("blocked");
    expect(ollama?.cause).toBe("port closed");
    expect(ollama?.advice).toContain("ollama pull qwen3:4b");
    expect(report.plugins.some((card) => card.name === "Hello")).toBe(true);
    expect(JSON.stringify(report).toLowerCase()).not.toContain("unavailable");
  } finally {
    app.close();
  }
});

test("chat names the pull command when the v1 model is not installed", async () => {
  const { app, methods } = await harness(async () => {
    throw new Error("fetch failed");
  });
  try {
    const raw = await methods.chat_send({ text: "hello there" });
    const state = JSON.parse(raw) as {
      messages: { role: string; text: string }[];
      models: { chat: string };
    };
    expect(state.models.chat).toBe("qwen3:4b");
    expect(state.messages.map((message) => message.text).join("\n")).toContain(
      "ollama pull qwen3:4b",
    );
    await expect(
      methods.set_models({
        chat: "missing:model",
        agent: "qwen3:8b",
        builder: "qwen2.5-coder:7b",
      }),
    ).rejects.toThrow("ollama pull missing:model");
  } finally {
    app.close();
  }
});

test("a stated fact is recalled in a later chat with its session source", async () => {
  const seen: ChatRequest[] = [];
  const { app, methods } = await harness(async (request) => {
    seen.push(request);
    return { text: "ok" };
  });
  try {
    await methods.chat_send({ text: "the revenue total is 220" });
    const facts = JSON.parse(await methods.memory_list({})) as {
      id: string;
      text: string;
      source: string;
    }[];
    expect(facts).toEqual([
      { id: "fact-1", text: "the revenue total is 220", source: "session-1" },
    ]);
    await methods.chat_new({});
    await methods.chat_send({ text: "what is the revenue total?" });
    const context = seen
      .at(-1)
      ?.messages.find((message) => message.role === "system");
    expect(context?.content).toContain("the revenue total is 220");
    expect(context?.content).toContain("source session-1");
    await methods.memory_delete({ id: "fact-1" });
    expect(JSON.parse(await methods.memory_list({}))).toEqual([]);
  } finally {
    app.close();
  }
});

test("a chat request sends tools to ollama and runs the tool call", async () => {
  const bodies: {
    model?: string;
    tools?: { function: { name: string } }[];
    messages?: { role: string; content: string }[];
  }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("example.com")) {
      return new Response("<html><title>Example Domain</title></html>");
    }
    return originalFetch(input);
  }) as typeof fetch;
  const connector = new OllamaConnector(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as (typeof bodies)[number];
    bodies.push(body);
    // qwen3:4b calls the tool again when the follow-up still offers tools.
    if (body.tools && body.tools.length > 0) {
      return new Response(
        JSON.stringify({
          message: {
            content: "",
            tool_calls: [
              {
                function: {
                  name: "browser.open",
                  arguments: { url: "https://example.com" },
                },
              },
            ],
          },
          done: true,
        }),
      );
    }
    const transcript = JSON.stringify(body.messages ?? []);
    const content = transcript.includes('"opened":false')
      ? "That visit was not allowed."
      : "The page title is Example Domain.";
    return new Response(JSON.stringify({ message: { content }, done: true }));
  });
  const dir = mkdtempSync(join(tmpdir(), "pa-chat-tools-"));
  const app = new DesktopApp({
    dataDir: dir,
    adapter: connector,
    probe: running,
  });
  await app.start();
  const methods = app.methods();
  try {
    const send = Promise.resolve(
      methods.chat_send({
        text: "open example.com and tell me the page title.",
      }),
    );
    const first = await Promise.race([
      send.then((raw) => ({ kind: "sent" as const, raw })),
      waitForApproval(methods),
    ]);
    if (first.kind !== "approval") {
      throw new Error("the visit ended before its approval");
    }
    const pendingDuring = JSON.parse(await methods.approvals({})) as {
      summary: string;
    }[];
    expect(pendingDuring).toHaveLength(1);
    expect(pendingDuring[0]?.summary).toBe("visit example.com");
    await methods.approval_act({
      action: "approve",
      id: first.id,
      draft: "",
      instruction: "",
      scope: "once",
      until: 0,
    });
    const state = JSON.parse(await send) as {
      messages: { role: string; text: string }[];
      streaming: boolean;
    };
    const cards = state.messages.filter(
      (message) => message.role === "approval",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]?.text).toContain("visit example.com");
    expect(cards[0]?.text).toContain("(approved)");
    expect(
      state.messages.some((message) => message.text === "browser.open"),
    ).toBe(false);
    expect(JSON.parse(await methods.approvals({}))).toEqual([]);
    expect(state.streaming).toBe(false);
    const reply = state.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.text)
      .join("\n");
    expect(reply).toContain("The page title is Example Domain.");
    expect(bodies.at(-1)?.tools).toBeUndefined();
    const offered = bodies[0]?.tools?.map((tool) => tool.function.name) ?? [];
    expect(bodies[0]?.model).toBe("qwen3:4b");
    expect(offered).toContain("browser.open");
    expect(offered).toContain("mail.summary");
    expect(
      bodies[0]?.messages?.some(
        (message) => message.role === "system" && /tool/i.test(message.content),
      ),
    ).toBe(true);
    expect(
      bodies.some((body) =>
        body.messages?.some(
          (message) =>
            message.role === "tool" &&
            message.content.includes("Example Domain"),
        ),
      ),
    ).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    app.close();
  }
});

test("a denied visit is one approval and the model says it was not allowed", async () => {
  const { app, methods } = await browserHarness(async (body) => {
    if (body.tools && body.tools.length > 0) {
      return toolCallResponse();
    }
    return textResponse("That visit was not allowed.");
  });
  try {
    const send = Promise.resolve(
      methods.chat_send({
        text: "open example.com and tell me the page title.",
      }),
    );
    const first = await Promise.race([
      send.then(() => ({ kind: "sent" as const })),
      waitForApproval(methods),
    ]);
    if (first.kind !== "approval") {
      throw new Error("the visit ended before its approval");
    }
    await methods.approval_act({
      action: "deny",
      id: first.id,
      draft: "",
      instruction: "",
      scope: "once",
      until: 0,
    });
    const state = JSON.parse(await send) as {
      messages: { role: string; text: string }[];
    };
    expect(
      state.messages.filter((message) => message.role === "approval"),
    ).toHaveLength(1);
    expect(
      state.messages.some((message) => message.text === "browser.open"),
    ).toBe(false);
    expect(
      state.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .join("\n"),
    ).toContain("not allowed");
  } finally {
    app.close();
  }
});

test("a follow-up model error is shown in the chat", async () => {
  const { app, methods } = await browserHarness(async (body) => {
    if (body.tools && body.tools.length > 0) {
      return toolCallResponse();
    }
    throw new Error("model exploded");
  });
  try {
    const send = Promise.resolve(
      methods.chat_send({
        text: "open example.com and tell me the page title.",
      }),
    );
    const first = await Promise.race([
      send.then(() => ({ kind: "sent" as const })),
      waitForApproval(methods),
    ]);
    if (first.kind !== "approval") {
      throw new Error("the visit ended before its approval");
    }
    await methods.approval_act({
      action: "approve",
      id: first.id,
      draft: "",
      instruction: "",
      scope: "once",
      until: 0,
    });
    const state = JSON.parse(await send) as {
      messages: { role: string; text: string }[];
    };
    expect(
      state.messages.some((message) => message.text === "browser.open"),
    ).toBe(false);
    expect(
      state.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .join("\n"),
    ).toContain("model exploded");
  } finally {
    app.close();
  }
});

test("a revenue question uses the agent tools and answers 220", async () => {
  const seen: ChatRequest[] = [];
  const { app, methods } = await harness(async (request) => {
    seen.push(request);
    if (seen.length === 1) {
      return {
        text: "I don't have access to your files.",
        toolCall: { name: "revenue.read", arguments: "{}" },
      };
    }
    return {
      text: "The total in revenue.csv is 220 (North 100, South 80, West 40).",
    };
  });
  try {
    const state = JSON.parse(
      await methods.chat_send({ text: "What's the total in revenue.csv?" }),
    ) as { messages: { role: string; text: string }[] };
    expect(seen[0]?.model).toBe("qwen3:8b");
    expect(seen[0]?.tools?.map((tool) => tool.function.name)).toContain(
      "revenue.read",
    );
    expect(
      seen[1]?.messages.some((message) => message.content.includes("220")),
    ).toBe(true);
    const reply = state.messages.find(
      (message) => message.role === "assistant",
    );
    expect(reply?.text).toContain("220");
    expect(reply?.text).toContain("North 100");
    expect(reply?.text).toContain("South 80");
    expect(reply?.text).toContain("West 40");
  } finally {
    app.close();
  }
});

test("approving a mail draft writes one local outbox file", async () => {
  const models: string[] = [];
  const { app, methods, dir } = await harness(async (request) => {
    models.push(request.model);
    return { text: "Sending the signed North contract today." };
  }, running);
  try {
    const mail = JSON.parse(await methods.mail_state({})) as {
      messages: { id: string; thread: string; from: string }[];
    };
    const north = mail.messages.find(
      (message) =>
        message.thread === "North contract" &&
        message.from !== "employee@example.com",
    );
    const drafted = JSON.parse(
      await methods.mail_draft({ id: north?.id ?? "" }),
    ) as { approvalId: string; draft: string };
    expect(models).toEqual(["qwen3:8b"]);
    expect(drafted.draft).toBe("Sending the signed North contract today.");
    await expect(methods.mail_draft({ id: north?.id ?? "" })).rejects.toThrow(
      /already waiting/,
    );
    const pending = JSON.parse(await methods.approvals({})) as unknown[];
    expect(pending).toHaveLength(1);
    await methods.approval_act({
      action: "approve",
      id: drafted.approvalId,
      draft: "",
      instruction: "",
      scope: "once",
      until: 0,
    });
    const outbox = join(dir, "outbox");
    const files = readdirSync(outbox).filter((name) => name.endsWith(".eml"));
    expect(files).toHaveLength(1);
    const text = readFileSync(join(outbox, files[0] ?? ""), "utf8");
    expect(text).toContain("In-Reply-To:");
    expect(text).toContain("Sending the signed North contract today.");
    expect(text).toContain("To: a@example.com");
  } finally {
    app.close();
  }
});

test("a failed agent draft does not queue the source message", async () => {
  const { app, methods } = await harness(async () => {
    throw new Error("model timed out");
  }, running);
  try {
    const mail = JSON.parse(await methods.mail_state({})) as {
      messages: { id: string; body: string }[];
    };
    const source = mail.messages.find(
      (message) => message.body === "Q4 plan note 1",
    );
    await expect(methods.mail_draft({ id: source?.id ?? "" })).rejects.toThrow(
      /could not draft/,
    );
    expect(JSON.parse(await methods.approvals({}))).toEqual([]);
    const echo = await harness(async () => {
      return { text: "Q4 plan note 1" };
    }, running);
    try {
      await expect(
        echo.methods.mail_draft({ id: source?.id ?? "" }),
      ).rejects.toThrow(/nothing was sent to Approvals/);
      expect(JSON.parse(await echo.methods.approvals({}))).toEqual([]);
    } finally {
      echo.app.close();
    }
  } finally {
    app.close();
  }
});

test("a reply to your own message goes to the other recipients", async () => {
  const { app, methods, dir } = await harness(async () => {
    return { text: "Here is the revised Q4 plan." };
  }, running);
  try {
    const mail = JSON.parse(await methods.mail_state({})) as {
      messages: { id: string; from: string; thread: string }[];
    };
    const own = mail.messages.find(
      (message) =>
        message.thread === "Q4 plan" && message.from === "employee@example.com",
    );
    const drafted = JSON.parse(
      await methods.mail_draft({ id: own?.id ?? "" }),
    ) as { approvalId: string };
    await methods.approval_act({
      action: "approve",
      id: drafted.approvalId,
      draft: "",
      instruction: "",
      scope: "once",
      until: 0,
    });
    const outbox = join(dir, "outbox");
    const files = readdirSync(outbox).filter((name) => name.endsWith(".eml"));
    const text = readFileSync(join(outbox, files[0] ?? ""), "utf8");
    expect(text).toContain("To: a@example.com");
    expect(text).not.toContain("To: employee@example.com");
    expect(text).toContain("Here is the revised Q4 plan.");
  } finally {
    app.close();
  }
});

test("the builder plans a revenue number widget and waits for approval", async () => {
  const { app, methods } = await harness();
  try {
    const plan = JSON.parse(
      await methods.builder_plan({
        prompt: "show total revenue as a big number",
      }),
    ) as { preview: string; steps: { name: string; state: string }[] };
    expect(plan.preview).toContain("220");
    expect(plan.preview).toContain("__PA_THEME__");
    expect(plan.steps.map((step) => step.name)).toEqual([
      "Draft",
      "Generate",
      "Check",
      "Install",
    ]);
    const installed = JSON.parse(await methods.builder_install({})) as {
      approvalId: string;
    };
    const pending = JSON.parse(await methods.approvals({})) as {
      id: string;
      summary: string;
    }[];
    expect(pending.map((item) => item.id)).toEqual([installed.approvalId]);
    expect(pending[0]?.summary).toBe("install 'Total revenue' widget");
  } finally {
    app.close();
  }
});

const running = async () => "running" as const;

type OllamaBody = {
  tools?: { function: { name: string } }[];
  messages?: { role: string; content: string }[];
};

function toolCallResponse(): Response {
  return new Response(
    JSON.stringify({
      message: {
        content: "",
        tool_calls: [
          {
            function: {
              name: "browser.open",
              arguments: { url: "https://example.com" },
            },
          },
        ],
      },
      done: true,
    }),
  );
}

function textResponse(content: string): Response {
  return new Response(JSON.stringify({ message: { content }, done: true }));
}

async function browserHarness(
  reply: (body: OllamaBody) => Response | Promise<Response>,
): Promise<{
  app: DesktopApp;
  methods: ReturnType<DesktopApp["methods"]>;
}> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("example.com")) {
      return new Response("<html><title>Example Domain</title></html>");
    }
    return originalFetch(input);
  }) as typeof fetch;
  const connector = new OllamaConnector(async (_url, init) =>
    reply(JSON.parse(String(init?.body)) as OllamaBody),
  );
  const app = new DesktopApp({
    dataDir: mkdtempSync(join(tmpdir(), "pa-browser-chat-")),
    adapter: connector,
    probe: running,
  });
  await app.start();
  const close = app.close.bind(app);
  app.close = () => {
    globalThis.fetch = originalFetch;
    close();
  };
  return { app, methods: app.methods() };
}

async function waitForApproval(
  methods: ReturnType<DesktopApp["methods"]>,
): Promise<{ kind: "approval"; id: string } | { kind: "none" }> {
  const started = Date.now();
  while (Date.now() - started < 800) {
    const pending = JSON.parse(await methods.approvals({})) as { id: string }[];
    const id = pending[0]?.id ?? "";
    if (id.length > 0) {
      return { kind: "approval", id };
    }
    await Bun.sleep(20);
  }
  return { kind: "none" };
}

async function harness(
  chat?: ModelAdapter["chat"],
  probe: () => Promise<"running" | "stopped"> = async () => "stopped",
): Promise<{
  app: DesktopApp;
  methods: ReturnType<DesktopApp["methods"]>;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "pa-desktop-"));
  const adapter: ModelAdapter = {
    async listModels() {
      return [];
    },
    chat:
      chat ??
      (async () => {
        return { text: "ok" };
      }),
    async structured<T>(): Promise<T> {
      return {} as T;
    },
  };
  const app = new DesktopApp({
    dataDir: dir,
    adapter,
    probe,
    now: () => Date.parse("2026-11-11T12:00:00.000Z"),
  });
  await app.start();
  return { app, methods: app.methods(), dir };
}
