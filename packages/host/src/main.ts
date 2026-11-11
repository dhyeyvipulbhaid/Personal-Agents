import { writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopApp } from "./desktop.ts";
import { encodeNotification, serveStdio } from "./rpc.ts";

const dataDir = process.env.PA_DATA_DIR || join(tmpdir(), "personal-agents");
const app = new DesktopApp({
  dataDir,
  audit: (entry) => {
    writeSync(1, encodeNotification("audit", entry));
  },
});

try {
  await app.start();
} catch (error) {
  const message =
    error instanceof Error ? error.message : "host failed to start";
  console.error(message);
  process.exit(1);
}

await serveStdio(app.methods());
