import { writeSync } from "node:fs";
import { HOST_VERSION } from "./version.ts";

const MAX_FRAME_BYTES = 1_000_000;

export type RpcId = number | string | null;

export type RpcResponse = {
  jsonrpc: "2.0";
  id: RpcId;
  result?: string;
  error?: { code: number; message: string };
};

/** One JSON-RPC message, prefixed with its byte length. */
export function encodeFrame(body: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(
    `Content-Length: ${body.byteLength}\r\n\r\n`,
  );
  const frame = new Uint8Array(header.byteLength + body.byteLength);
  frame.set(header, 0);
  frame.set(body, header.byteLength);
  return frame;
}

/**
 * Returns the next frame, or null when more bytes are required.
 * Throws when a finished header is not a Content-Length line.
 */
export function decodeFrame(
  buffer: Uint8Array,
): { body: Uint8Array; rest: Uint8Array } | null {
  const end = indexOfHeaderEnd(buffer);
  if (end === -1) {
    return null;
  }
  const header = new TextDecoder().decode(buffer.subarray(0, end));
  const match = /^Content-Length: (\d+)$/.exec(header);
  if (!match) {
    throw new Error(`bad frame header: ${header}`);
  }
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length) || length > MAX_FRAME_BYTES) {
    throw new Error("frame is too large");
  }
  const start = end + 4;
  if (buffer.byteLength < start + length) {
    return null;
  }
  return {
    body: buffer.subarray(start, start + length),
    rest: buffer.subarray(start + length),
  };
}

export class FrameBuffer {
  private buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > 0) {
      const merged = new Uint8Array(this.buffer.byteLength + chunk.byteLength);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.byteLength);
      this.buffer = merged;
    }
    if (this.buffer.byteLength > MAX_FRAME_BYTES) {
      throw new Error("frame is too large");
    }
    const frames: Uint8Array[] = [];
    for (;;) {
      const decoded = decodeFrame(this.buffer);
      if (decoded === null) {
        return frames;
      }
      frames.push(Uint8Array.from(decoded.body));
      this.buffer = Uint8Array.from(decoded.rest);
    }
  }
}

export type RpcMethod = (params: unknown) => string | Promise<string>;

export type RpcMethods = Record<string, RpcMethod>;

/** A notification frame. The shell records these; they are not replies. */
export function encodeNotification(
  method: string,
  params: unknown,
): Uint8Array {
  return encodeFrame(
    new TextEncoder().encode(
      JSON.stringify({ jsonrpc: "2.0", method, params }),
    ),
  );
}

/** Handles one request body. A notification (no id) produces no response. */
export async function dispatch(
  message: unknown,
  methods: RpcMethods = {},
): Promise<RpcResponse | null> {
  if (!isRecord(message)) {
    return invalid(null);
  }
  const id = "id" in message ? message.id : undefined;
  if (
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    (id !== undefined && !isRpcId(id))
  ) {
    return invalid(isRpcId(id) ? id : null);
  }
  if (id === undefined) {
    return null;
  }
  if (message.method === "ping") {
    return { jsonrpc: "2.0", id, result: "pong" };
  }
  if (message.method === "version") {
    return { jsonrpc: "2.0", id, result: HOST_VERSION };
  }
  const extra = methods[message.method];
  if (extra) {
    try {
      return { jsonrpc: "2.0", id, result: await extra(message.params) };
    } catch (error) {
      const text = error instanceof Error ? error.message : "call failed";
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: text },
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  };
}

/** Turns one request body into a response frame, or null when no reply is due. */
export async function handleBody(
  body: Uint8Array,
  methods: RpcMethods = {},
): Promise<Uint8Array | null> {
  let response: RpcResponse | null;
  try {
    response = await dispatch(
      JSON.parse(new TextDecoder().decode(body)),
      methods,
    );
  } catch {
    response = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };
  }
  if (response === null) {
    return null;
  }
  return encodeFrame(new TextEncoder().encode(JSON.stringify(response)));
}

/** Reads framed requests from stdin and writes framed responses to stdout. */
export async function serveStdio(methods: RpcMethods = {}): Promise<void> {
  const frames = new FrameBuffer();
  const reader = Bun.stdin.stream().getReader();
  const pending: Promise<void>[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        await Promise.all(pending);
        return;
      }
      for (const body of frames.push(value)) {
        pending.push(answer(body, methods));
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "frame error";
    console.error(message);
  }
}

/** One request at a time would block chat polling, so replies run together. */
function answer(body: Uint8Array, methods: RpcMethods): Promise<void> {
  return handleBody(body, methods)
    .then((response) => {
      if (response !== null) {
        writeSync(1, response);
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "call failed";
      console.error(message);
    });
}

function invalid(id: RpcId): RpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32600, message: "Invalid Request" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function indexOfHeaderEnd(buffer: Uint8Array): number {
  for (let index = 0; index + 3 < buffer.byteLength; index++) {
    if (
      buffer[index] === 13 &&
      buffer[index + 1] === 10 &&
      buffer[index + 2] === 13 &&
      buffer[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}
