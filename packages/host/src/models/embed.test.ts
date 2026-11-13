import { expect, test } from "bun:test";
import { OllamaConnector } from "./ollama.ts";

test("the host connector embeds with nomic-embed-text", async () => {
  const seen: { url: string; body: string }[] = [];
  const connector = new OllamaConnector(async (url, init) => {
    seen.push({ url, body: String(init?.body ?? "") });
    return Response.json({ embeddings: [[0.2, 0.4, 0.6]] });
  });

  expect(
    await connector.embed("nomic-embed-text", "where the dog plays"),
  ).toEqual([0.2, 0.4, 0.6]);
  expect(seen[0]?.url).toBe("http://127.0.0.1:11434/api/embed");
  expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({
    model: "nomic-embed-text",
    input: "where the dog plays",
  });
});

test("the host connector falls back to the older embeddings route", async () => {
  const connector = new OllamaConnector(async (url) => {
    if (url.endsWith("/api/embed")) {
      return new Response("missing", { status: 404 });
    }
    return Response.json({ embedding: [1, 0, 0] });
  });

  expect(await connector.embed("nomic-embed-text", "pepper")).toEqual([
    1, 0, 0,
  ]);
});

test("a down Ollama embedder throws and does not invent a vector", async () => {
  const connector = new OllamaConnector(async () => {
    throw new Error("connect ECONNREFUSED");
  });

  await expect(connector.embed("nomic-embed-text", "pepper")).rejects.toThrow(
    /not reachable/,
  );
});
