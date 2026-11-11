import { defaultPolicy, type Policy } from "./policy.ts";

export type GrantDecision = "allow" | "deny" | "always";

export type Grant = {
  capability: string;
  scope: string;
  decision: GrantDecision;
};

export type AuditRecord = {
  at: string;
  pluginId: string;
  capability: string;
  scope: string;
  effects: string[];
  decision: "allow" | "deny" | "needs-approval";
  reason: string;
  summary: string;
};

export type Outcome = {
  decision: AuditRecord["decision"];
  reason: string;
  audit: AuditRecord;
};

const CAPABILITY = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

/** Decides one plugin request and returns the audit record for it. */
export function decide(
  request: unknown,
  policy: Policy = defaultPolicy,
  at: Date = new Date(),
): Outcome {
  const parsed = parseRequest(request);
  const outcome = judge(policy, parsed);
  const audit: AuditRecord = {
    at: at.toISOString(),
    pluginId: parsed.pluginId,
    capability: parsed.capability,
    scope: parsed.scope,
    effects: parsed.effects,
    decision: outcome.decision,
    reason: outcome.reason,
    summary: `${parsed.pluginId} ${parsed.capability} ${parsed.scope}: ${outcome.decision} (${outcome.reason})`,
  };
  return { decision: outcome.decision, reason: outcome.reason, audit };
}

type ParsedRequest = {
  pluginId: string;
  capability: string;
  scope: string;
  effects: string[];
  grants: Grant[];
};

function judge(
  policy: Policy,
  request: ParsedRequest,
): { decision: Outcome["decision"]; reason: string } {
  if (!CAPABILITY.test(request.capability)) {
    return { decision: "deny", reason: "invalid capability" };
  }
  const policyDenial = policyDenies(policy, request.capability, request.scope);
  const grant = matchingGrant(
    request.grants,
    request.capability,
    request.scope,
  );
  if (policyDenial && grant && grant.decision !== "deny") {
    return { decision: "deny", reason: "policy" };
  }
  if (policyDenial) {
    return { decision: "deny", reason: "policy" };
  }
  if (!grant) {
    return { decision: "deny", reason: "outside grant" };
  }
  if (grant.decision === "deny") {
    return { decision: "deny", reason: "grant" };
  }
  if (
    request.effects.includes("deletes") ||
    request.effects.includes("sends")
  ) {
    const reason = request.effects.includes("sends") ? "sends" : "deletes";
    return { decision: "needs-approval", reason };
  }
  return { decision: "allow", reason: "grant" };
}

function policyDenies(
  policy: Policy,
  capability: string,
  scope: string,
): boolean {
  const resource = capability.slice(0, capability.indexOf("."));
  if (resource === "models") {
    return !policy.models.allowed.some((pattern) => globMatch(pattern, scope));
  }
  if (resource === "connectors") {
    return !policy.connectors.allowed.includes(scope);
  }
  if (resource === "files") {
    return !policy.connectors.allowed.includes("files");
  }
  if (resource === "mail") {
    return !policy.connectors.allowed.includes("mail-local");
  }
  return true;
}

function matchingGrant(
  grants: Grant[],
  capability: string,
  scope: string,
): Grant | undefined {
  return grants.find(
    (grant) =>
      grant.capability === capability && scopeInside(grant.scope, scope),
  );
}

function scopeInside(grantScope: string, requested: string): boolean {
  if (grantScope === "*") {
    return true;
  }
  if (requested === grantScope) {
    return true;
  }
  const root = grantScope.endsWith("/") ? grantScope : `${grantScope}/`;
  return requested.startsWith(root);
}

function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

function parseRequest(value: unknown): ParsedRequest {
  const record = isRecord(value) ? value : {};
  const pluginId =
    typeof record.pluginId === "string" && record.pluginId.length > 0
      ? record.pluginId
      : "unknown";
  const capability =
    typeof record.capability === "string" ? record.capability : "";
  const scope = typeof record.scope === "string" ? record.scope : "";
  const effects = Array.isArray(record.effects)
    ? record.effects.filter((item): item is string => typeof item === "string")
    : [];
  const grants = Array.isArray(record.grants)
    ? record.grants.filter(isGrant)
    : [];
  return { pluginId, capability, scope, effects, grants };
}

function isGrant(value: unknown): value is Grant {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.capability === "string" &&
    typeof value.scope === "string" &&
    (value.decision === "allow" ||
      value.decision === "deny" ||
      value.decision === "always")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
