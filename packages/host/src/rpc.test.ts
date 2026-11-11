import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  decodeFrame,
  dispatch,
  encodeFrame,
  FrameBuffer,
  handleBody,
} from "./rpc.ts";
import { HOST_VERSION } from "./version.ts";

test("host version matches the package version", async () => {
  const pkg = (await Bun.file(
    new URL("../package.json", import.meta.url),
  ).json()) as { version: string };

  expect(HOST_VERSION).toBe(pkg.version);
});

test("a frame round-trips and keeps bytes that follow it", () => {
  const body = new TextEncoder().encode(
    '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  );
  const frame = encodeFrame(body);
  const extra = new TextEncoder().encode("next");
  const buffer = new Uint8Array(frame.byteLength + extra.byteLength);
  buffer.set(frame, 0);
  buffer.set(extra, frame.byteLength);

  const decoded = decodeFrame(buffer);
  if (decoded === null) {
    throw new Error("expected a complete frame");
  }

  expect(new TextDecoder().decode(decoded.body)).toBe(
    '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  );
  expect(new TextDecoder().decode(decoded.rest)).toBe("next");
  expect(new TextDecoder().decode(frame.subarray(0, frame.indexOf(13)))).toBe(
    `Content-Length: ${body.byteLength}`,
  );
});

test("content length counts utf-8 bytes", () => {
  const body = new TextEncoder().encode('{"t":"é"}');

  expect(body.byteLength).toBe(10);
  expect('{"t":"é"}'.length).toBe(9);
  const frame = encodeFrame(body);
  expect(new TextDecoder().decode(frame.subarray(0, frame.indexOf(13)))).toBe(
    "Content-Length: 10",
  );
});

test("an incomplete frame waits for the rest of the body", () => {
  const frame = encodeFrame(new TextEncoder().encode("{}"));
  const buffer = new FrameBuffer();

  expect(buffer.push(frame.subarray(0, frame.byteLength - 1))).toEqual([]);
  const frames = buffer.push(frame.subarray(frame.byteLength - 1));

  expect(frames.map((item) => new TextDecoder().decode(item))).toEqual(["{}"]);
});

test("two frames in one chunk both decode", () => {
  const first = encodeFrame(new TextEncoder().encode("[]"));
  const second = encodeFrame(new TextEncoder().encode("{}"));
  const both = new Uint8Array(first.byteLength + second.byteLength);
  both.set(first, 0);
  both.set(second, first.byteLength);

  const frames = new FrameBuffer().push(both);

  expect(frames.map((item) => new TextDecoder().decode(item))).toEqual([
    "[]",
    "{}",
  ]);
});

test("a finished header without a content length is rejected", () => {
  expect(() => decodeFrame(new TextEncoder().encode("Hello\r\n\r\n"))).toThrow(
    /bad frame header/,
  );
});

test("ping and version answer over a framed response", () => {
  expect(responseFor({ jsonrpc: "2.0", id: 7, method: "ping" })).toEqual({
    jsonrpc: "2.0",
    id: 7,
    result: "pong",
  });
  expect(responseFor({ jsonrpc: "2.0", id: 8, method: "version" })).toEqual({
    jsonrpc: "2.0",
    id: 8,
    result: HOST_VERSION,
  });
});

test("an unknown method returns method not found", () => {
  expect(responseFor({ jsonrpc: "2.0", id: 3, method: "other" })).toEqual({
    jsonrpc: "2.0",
    id: 3,
    error: { code: -32601, message: "Method not found" },
  });
});

test("a request that is not JSON-RPC is invalid", () => {
  expect(responseFor({ id: 4 })).toEqual({
    jsonrpc: "2.0",
    id: 4,
    error: { code: -32600, message: "Invalid Request" },
  });
});

test("a body that is not JSON is a parse error", () => {
  const frame = handleBody(new TextEncoder().encode("nope"));
  if (frame === null) {
    throw new Error("expected a parse error frame");
  }
  const decoded = decodeFrame(frame);
  if (decoded === null) {
    throw new Error("parse error frame was incomplete");
  }

  expect(JSON.parse(new TextDecoder().decode(decoded.body))).toEqual({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32700, message: "Parse error" },
  });
});

test("a notification gets no response", () => {
  expect(dispatch({ jsonrpc: "2.0", method: "ping" })).toBeNull();
  expect(
    handleBody(new TextEncoder().encode('{"jsonrpc":"2.0","method":"ping"}')),
  ).toBeNull();
});

test("the stdio server answers ping and version", async () => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stderrText = "";
  const drainStderr = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      stderrText += decoder.decode(value);
    }
  })();
  const frames = new FrameBuffer();
  const reader = proc.stdout.getReader();
  const queued: unknown[] = [];

  async function nextResponse(): Promise<unknown> {
    const waiting = queued.shift();
    if (waiting !== undefined) {
      return waiting;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        throw new Error(`stdout closed\n${stderrText}`);
      }
      const bodies = frames.push(value);
      if (bodies.length > 0) {
        const messages = bodies.map((body) =>
          JSON.parse(new TextDecoder().decode(body)),
        );
        queued.push(...messages.slice(1));
        return messages[0];
      }
    }
  }

  async function send(id: number, method: string): Promise<void> {
    const body = new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", id, method }),
    );
    proc.stdin.write(encodeFrame(body));
    await proc.stdin.flush();
  }

  try {
    await send(1, "ping");
    expect(await nextResponse()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: "pong",
    });
    await send(2, "version");
    expect(await nextResponse()).toEqual({
      jsonrpc: "2.0",
      id: 2,
      result: HOST_VERSION,
    });
  } finally {
    proc.kill();
    await proc.exited;
    await drainStderr;
  }
}, 10_000);

function responseFor(message: unknown): unknown {
  const frame = handleBody(new TextEncoder().encode(JSON.stringify(message)));
  if (frame === null) {
    return null;
  }
  const decoded = decodeFrame(frame);
  if (decoded === null) {
    throw new Error("response frame was incomplete");
  }
  return JSON.parse(new TextDecoder().decode(decoded.body));
}
