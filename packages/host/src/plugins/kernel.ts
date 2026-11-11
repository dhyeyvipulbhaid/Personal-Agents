import { HOST_VERSION } from "../version.ts";
import {
  type EffectName,
  type PluginManifest,
  validateManifest,
} from "./manifest.ts";
import workerSource from "./sandbox-worker.js" with { type: "text" };

const THEME_TOKEN = "__PA_THEME__";
const DEFAULT_CALL_TIMEOUT_MS = 1_000;

export type TileEffect = {
  effect: "tile";
  id: string;
  title: string;
  html: string;
};

export type ScheduleEffect = {
  effect: "schedule";
  everyMs: number;
};

export type ConnectorEffect = {
  effect: "connector";
  id: string;
};

export type PluginEffect = TileEffect | ScheduleEffect | ConnectorEffect;

export type Registration = PluginEffect & { pluginId: string };

type PluginHealth = "healthy" | "unhealthy";

type LoadedPlugin = {
  manifest: PluginManifest;
  health: PluginHealth;
  worker: Worker | null;
  workerUrl: string | null;
  registrations: PluginEffect[];
  timers: ReturnType<typeof setInterval>[];
};

type WorkerReply = {
  ok: boolean;
  manifest?: unknown;
  registrations?: unknown;
  message?: string;
};

/** Loads plugins, times out each call, and drops their registrations on unload. */
export class PluginKernel {
  private readonly callTimeoutMs: number;
  private readonly coreVersion: string;
  private readonly plugins = new Map<string, LoadedPlugin>();
  private nextCall = 0;

  constructor(options?: { callTimeoutMs?: number; coreVersion?: string }) {
    this.callTimeoutMs = options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.coreVersion = options?.coreVersion ?? HOST_VERSION;
  }

  async load(source: string): Promise<void> {
    const workerUrl = URL.createObjectURL(
      new Blob([workerSource], { type: "application/javascript" }),
    );
    const worker = new Worker(workerUrl);
    let manifest: PluginManifest | null = null;
    try {
      const inspected = await this.request(
        worker,
        { op: "inspect", source },
        this.callTimeoutMs,
      );
      manifest = validateManifest(inspected.manifest, this.coreVersion);
      if (this.plugins.has(manifest.id)) {
        throw new Error("plugin is already loaded");
      }
      const applied = await this.request(
        worker,
        { op: "apply" },
        this.callTimeoutMs,
      );
      const registrations = acceptRegistrations(
        manifest,
        applied.registrations,
      );
      this.plugins.set(manifest.id, {
        manifest,
        health: "healthy",
        worker,
        workerUrl,
        registrations,
        timers: [],
      });
      this.startSchedules(manifest.id);
    } catch (error) {
      const timedOut =
        error instanceof Error && error.message === "plugin call timed out";
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
      if (timedOut && manifest && !this.plugins.has(manifest.id)) {
        this.plugins.set(manifest.id, {
          manifest,
          health: "unhealthy",
          worker: null,
          workerUrl: null,
          registrations: [],
          timers: [],
        });
      }
      throw error;
    }
  }

  unload(id: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      throw new Error("plugin is not loaded");
    }
    this.drop(plugin);
    this.plugins.delete(id);
  }

  close(): void {
    for (const id of [...this.plugins.keys()]) {
      this.unload(id);
    }
  }

  loaded(): { id: string; name: string; health: PluginHealth }[] {
    return [...this.plugins.values()].map((plugin) => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      health: plugin.health,
    }));
  }

  health(id: string): PluginHealth {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      throw new Error("plugin is not loaded");
    }
    return plugin.health;
  }

  registrations(): Registration[] {
    const list: Registration[] = [];
    for (const [pluginId, plugin] of this.plugins) {
      if (plugin.health !== "healthy") {
        continue;
      }
      for (const effect of plugin.registrations) {
        list.push({ ...effect, pluginId });
      }
    }
    return list;
  }

  tiles(): TileEffect[] {
    const tiles: TileEffect[] = [];
    for (const registration of this.registrations()) {
      if (registration.effect === "tile") {
        tiles.push({
          effect: "tile",
          id: registration.id,
          title: registration.title,
          html: registration.html,
        });
      }
    }
    return tiles;
  }

  private startSchedules(id: string): void {
    const plugin = this.readyPlugin(id);
    if (plugin === null) {
      return;
    }
    for (const registration of plugin.registrations) {
      if (registration.effect !== "schedule") {
        continue;
      }
      const timer = setInterval(() => {
        void this.runSchedule(id);
      }, registration.everyMs);
      if ("unref" in timer && typeof timer.unref === "function") {
        timer.unref();
      }
      plugin.timers.push(timer);
    }
  }

  private async runSchedule(id: string): Promise<void> {
    const plugin = this.readyPlugin(id);
    if (plugin === null) {
      return;
    }
    try {
      await this.request(plugin.worker, { op: "schedule" }, this.callTimeoutMs);
    } catch {
      this.markUnhealthy(id);
    }
  }

  private readyPlugin(id: string): (LoadedPlugin & { worker: Worker }) | null {
    const plugin = this.plugins.get(id);
    if (plugin === undefined || plugin.health !== "healthy") {
      return null;
    }
    if (plugin.worker === null) {
      return null;
    }
    return plugin as LoadedPlugin & { worker: Worker };
  }

  private markUnhealthy(id: string): void {
    const plugin = this.plugins.get(id);
    if (!plugin || plugin.health === "unhealthy") {
      return;
    }
    this.drop(plugin);
    plugin.health = "unhealthy";
    plugin.worker = null;
    plugin.registrations = [];
  }

  private drop(plugin: LoadedPlugin): void {
    for (const timer of plugin.timers) {
      clearInterval(timer);
    }
    plugin.timers = [];
    plugin.worker?.terminate();
    if (plugin.workerUrl !== null) {
      URL.revokeObjectURL(plugin.workerUrl);
      plugin.workerUrl = null;
    }
  }

  private request(
    worker: Worker,
    message: { op: string; source?: string },
    timeoutMs: number,
  ): Promise<WorkerReply> {
    this.nextCall += 1;
    const id = this.nextCall;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        worker.terminate();
        reject(new Error("plugin call timed out"));
      }, timeoutMs);
      const onMessage = (event: MessageEvent) => {
        const reply = readReply(event.data, id);
        if (reply === null) {
          return;
        }
        cleanup();
        if (reply.ok) {
          resolve(reply);
          return;
        }
        reject(new Error(reply.message ?? "plugin call failed"));
      };
      const onError = (event: ErrorEvent) => {
        cleanup();
        const detail = event.message ? `: ${event.message}` : "";
        reject(new Error(`plugin stopped${detail}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({ ...message, id });
    });
  }
}

function acceptRegistrations(
  manifest: PluginManifest,
  value: unknown,
): PluginEffect[] {
  if (!Array.isArray(value)) {
    throw new Error("registrations must be a list");
  }
  const accepted: PluginEffect[] = [];
  for (const item of value) {
    accepted.push(acceptRegistration(manifest, item, accepted));
  }
  return accepted;
}

function acceptRegistration(
  manifest: PluginManifest,
  value: unknown,
  accepted: PluginEffect[],
): PluginEffect {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("registration must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.effect === "tile") {
    requireEffect(manifest, "tile");
    if (accepted.some((item) => item.effect === "tile")) {
      throw new Error("tile is already registered");
    }
    if (typeof record.id !== "string" || record.id !== manifest.id) {
      throw new Error("tile id must match the plugin");
    }
    if (
      typeof record.title !== "string" ||
      record.title !== manifest.tile?.title
    ) {
      throw new Error("tile title must match the manifest");
    }
    if (
      typeof record.html !== "string" ||
      record.html.length === 0 ||
      record.html.length > 100_000 ||
      !record.html.includes(THEME_TOKEN)
    ) {
      throw new Error("tile html is invalid");
    }
    return {
      effect: "tile",
      id: record.id,
      title: record.title,
      html: record.html,
    };
  }
  if (record.effect === "connector") {
    requireEffect(manifest, "connector");
    if (accepted.some((item) => item.effect === "connector")) {
      throw new Error("connector is already registered");
    }
    return { effect: "connector", id: manifest.id };
  }
  if (record.effect === "schedule") {
    requireEffect(manifest, "schedule");
    if (accepted.some((item) => item.effect === "schedule")) {
      throw new Error("schedule is already registered");
    }
    if (
      typeof record.everyMs !== "number" ||
      record.everyMs !== manifest.schedule?.everyMs
    ) {
      throw new Error("schedule interval must match the manifest");
    }
    return { effect: "schedule", everyMs: record.everyMs };
  }
  throw new Error("unknown effect");
}

function requireEffect(manifest: PluginManifest, effect: EffectName): void {
  if (!manifest.effects.includes(effect)) {
    throw new Error(`${effect} effect is not declared`);
  }
}

function readReply(value: unknown, id: number): WorkerReply | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.id !== id) {
    return null;
  }
  if (record.ok === true) {
    return {
      ok: true,
      manifest: record.manifest,
      registrations: record.registrations,
    };
  }
  if (record.ok === false) {
    return {
      ok: false,
      message:
        typeof record.message === "string"
          ? record.message
          : "plugin call failed",
    };
  }
  return null;
}
