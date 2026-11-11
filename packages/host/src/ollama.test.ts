import { expect, test } from "bun:test";
import { probeOllama } from "./ollama.ts";

test("a closed local port reports that Ollama is stopped", async () => {
  expect(await probeOllama(1, 200)).toBe("stopped");
});
