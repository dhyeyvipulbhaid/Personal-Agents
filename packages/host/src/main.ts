import { HELLO_PLUGIN_SOURCE } from "./plugins/hello.ts";
import { kernel } from "./plugins/runtime.ts";
import { serveStdio } from "./rpc.ts";

try {
  await kernel.load(HELLO_PLUGIN_SOURCE);
} catch (error) {
  const message =
    error instanceof Error ? error.message : "hello plugin failed";
  console.error(message);
  process.exit(1);
}

await serveStdio({
  widgets: () => JSON.stringify(kernel.tiles()),
});
