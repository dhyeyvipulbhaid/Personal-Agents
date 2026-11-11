import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, FrameBuffer } from "../packages/host/src/rpc.ts";

export type HostClient = {
  dataDir: string;
  audits: unknown[];
  call: (method: string, params?: unknown) => Promise<string>;
  stop: () => Promise<void>;
};

/** Speaks JSON-RPC to the real agent host process. */
export async function startHost(): Promise<HostClient> {
  const dataDir = mkdtempSync(join(tmpdir(), "pa-host-pages-"));
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../packages/host/src/main.ts")],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PA_DATA_DIR: dataDir },
    },
  );
  const audits: unknown[] = [];
  const frames = new FrameBuffer();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let stderrText = "";
  const stderr = (async () => {
    const stderrReader = proc.stderr.getReader();
    for (;;) {
      const { done, value } = await stderrReader.read();
      if (done) {
        return;
      }
      stderrText += decoder.decode(value);
    }
  })();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      for (const body of frames.push(value)) {
        const message = JSON.parse(decoder.decode(body)) as {
          id?: number;
          method?: string;
          params?: unknown;
          result?: string;
          error?: { message?: string };
        };
        if (message.method === "audit" && message.id === undefined) {
          audits.push(message.params);
          continue;
        }
        if (typeof message.id !== "number") {
          continue;
        }
        const waiter = pending.get(message.id);
        if (!waiter) {
          continue;
        }
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(new Error(message.error.message ?? "host call failed"));
        } else {
          waiter.resolve(message.result ?? "");
        }
      }
    }
  })();

  function call(method: string, params?: unknown): Promise<string> {
    const id = nextId;
    nextId += 1;
    const payload: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) {
      payload.params = params;
    }
    const response = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timed out waiting for ${method}\n${stderrText}`));
        }
      }, 20_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(String(value));
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    proc.stdin.write(
      encodeFrame(new TextEncoder().encode(JSON.stringify(payload))),
    );
    void proc.stdin.flush();
    return response;
  }

  try {
    if ((await call("ping")) !== "pong") {
      throw new Error("host ping did not answer pong");
    }
  } catch (error) {
    proc.kill();
    await proc.exited;
    await pump;
    await stderr;
    throw error;
  }

  return {
    dataDir,
    audits,
    call,
    async stop() {
      proc.kill();
      await proc.exited;
      await Promise.allSettled([pump, stderr]);
    },
  };
}
