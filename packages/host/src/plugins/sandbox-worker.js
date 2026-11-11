// Plugin code runs in this worker so a call that hangs can be stopped.
// Network globals are replaced before the plugin runs. The plugin source
// also receives those names as local bindings, so fetch() cannot reach
// the worker's original network stack.

function blocked() {
  throw new Error("network is blocked");
}

for (const name of ["fetch", "WebSocket", "XMLHttpRequest", "EventSource"]) {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: blocked,
    });
  } catch {
    // The plugin still receives a local binding with the same name.
  }
}

let plugin = null;

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message.id !== "number") {
    return;
  }
  void handle(message);
};

async function handle(message) {
  try {
    if (message.op === "inspect") {
      plugin = loadPlugin(message.source);
      reply({ id: message.id, ok: true, manifest: plugin.manifest });
      return;
    }
    if (!plugin) {
      throw new Error("plugin is not loaded");
    }
    if (message.op === "apply") {
      const registrations = [];
      await plugin.apply({
        register(input) {
          registrations.push(cloneRegistration(input));
        },
      });
      reply({ id: message.id, ok: true, registrations });
      return;
    }
    if (message.op === "schedule") {
      if (plugin.onSchedule) {
        await plugin.onSchedule();
      }
      reply({ id: message.id, ok: true, registrations: [] });
      return;
    }
    throw new Error("unknown plugin call");
  } catch (error) {
    const text = error instanceof Error ? error.message : "plugin call failed";
    reply({ id: message.id, ok: false, message: text });
  }
}

function reply(message) {
  self.postMessage(message);
}

function cloneRegistration(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("registration must be an object");
  }
  return JSON.parse(JSON.stringify(input));
}

function loadPlugin(source) {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.length > 200_000
  ) {
    throw new Error("plugin source is invalid");
  }
  if (/(^|\n)\s*import\s|\bimport\s*\(|\brequire\s*\(/.test(source)) {
    throw new Error("plugin imports are not available");
  }
  const transformed = source
    .replace(/\bexport\s+async\s+function\s+apply\b/, "async function apply")
    .replace(/\bexport\s+function\s+apply\b/, "function apply")
    .replace(
      /\bexport\s+async\s+function\s+onSchedule\b/,
      "async function onSchedule",
    )
    .replace(/\bexport\s+function\s+onSchedule\b/, "function onSchedule")
    .replace(/\bexport\s+const\s+manifest\b/, "const manifest");
  const factory = new Function(
    "fetch",
    "WebSocket",
    "XMLHttpRequest",
    "EventSource",
    "Bun",
    `"use strict";
${transformed}
if (typeof apply !== "function") throw new Error("plugin apply is missing");
return {
  manifest,
  apply,
  onSchedule: typeof onSchedule === "function" ? onSchedule : undefined
};`,
  );
  return factory(blocked, blocked, blocked, blocked, undefined);
}
