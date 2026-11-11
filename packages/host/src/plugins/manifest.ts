/** Effects a plugin may register. Each one is removed on unload. */
export const EFFECT_NAMES = ["tile", "schedule", "connector"] as const;

export type EffectName = (typeof EFFECT_NAMES)[number];

export type PluginManifest = {
  id: string;
  name: string;
  version: string;
  minCoreVersion: string;
  tile?: { title: string };
  schedule?: { everyMs: number };
  effects: EffectName[];
};

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Checks a plugin manifest against this core version. */
export function validateManifest(
  value: unknown,
  coreVersion: string,
): PluginManifest {
  const record = recordValue(value, "manifest must be an object");
  const id = requiredString(record, "id");
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
    throw new Error("manifest id is invalid");
  }
  const name = requiredString(record, "name");
  if (name.length > 80 || controlChars(name)) {
    throw new Error("manifest name is invalid");
  }
  const version = semverField(record, "version");
  const minCoreVersion = semverField(record, "minCoreVersion");
  if (!SEMVER.test(coreVersion)) {
    throw new Error("core version is invalid");
  }
  if (compareSemver(minCoreVersion, coreVersion) > 0) {
    throw new Error("plugin requires a newer core");
  }
  const tile = tileField(record.tile);
  const schedule = scheduleField(record.schedule);
  const effects = effectsField(record.effects);
  if (tile && !effects.includes("tile")) {
    throw new Error("tile requires the tile effect");
  }
  if (!tile && effects.includes("tile")) {
    throw new Error("tile effect requires a tile");
  }
  if (schedule && !effects.includes("schedule")) {
    throw new Error("schedule requires the schedule effect");
  }
  if (!schedule && effects.includes("schedule")) {
    throw new Error("schedule effect requires a schedule");
  }
  return {
    id,
    name,
    version,
    minCoreVersion,
    ...(tile ? { tile } : {}),
    ...(schedule ? { schedule } : {}),
    effects,
  };
}

function tileField(value: unknown): { title: string } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = recordValue(value, "tile must be an object");
  const title = requiredString(record, "title");
  if (title.length > 80 || controlChars(title)) {
    throw new Error("tile title is invalid");
  }
  return { title };
}

function scheduleField(value: unknown): { everyMs: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = recordValue(value, "schedule must be an object");
  const everyMs = record.everyMs;
  if (
    typeof everyMs !== "number" ||
    !Number.isInteger(everyMs) ||
    everyMs < 1_000 ||
    everyMs > 86_400_000
  ) {
    throw new Error("schedule everyMs is invalid");
  }
  return { everyMs };
}

function effectsField(value: unknown): EffectName[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("manifest effects are required");
  }
  const effects: EffectName[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !isEffectName(item)) {
      throw new Error("manifest effect is unknown");
    }
    if (effects.includes(item)) {
      throw new Error("manifest effect is duplicated");
    }
    effects.push(item);
  }
  return effects;
}

function isEffectName(value: string): value is EffectName {
  return (EFFECT_NAMES as readonly string[]).includes(value);
}

function semverField(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key);
  if (!SEMVER.test(value)) {
    throw new Error(`manifest ${key} is invalid`);
  }
  return value;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`manifest ${key} is invalid`);
  }
  return value;
}

function recordValue(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as Record<string, unknown>;
}

function controlChars(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function compareSemver(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
}
