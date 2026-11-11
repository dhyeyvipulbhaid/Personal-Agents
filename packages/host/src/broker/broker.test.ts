import { expect, test } from "bun:test";
import { decide } from "./broker.ts";
import { defaultPolicy } from "./policy.ts";

const at = new Date("2026-11-11T12:00:00.000Z");

const fileGrant = {
  capability: "files.read",
  scope: "/data/granted",
  decision: "always" as const,
};

test("a file outside the grant is denied and logged", () => {
  const outcome = decide(
    {
      pluginId: "files",
      capability: "files.read",
      scope: "/data/other/secret.csv",
      grants: [fileGrant],
    },
    defaultPolicy,
    at,
  );

  expect(outcome.decision).toBe("deny");
  expect(outcome.reason).toBe("outside grant");
  expect(outcome.audit.decision).toBe("deny");
  expect(outcome.audit.pluginId).toBe("files");
  expect(outcome.audit.summary).toContain("outside grant");
});

test("a policy deny beats a user allow", () => {
  const outcome = decide(
    {
      pluginId: "mail",
      capability: "connectors.use",
      scope: "mail-remote",
      grants: [
        {
          capability: "connectors.use",
          scope: "mail-remote",
          decision: "allow",
        },
      ],
    },
    defaultPolicy,
    at,
  );

  expect(defaultPolicy.connectors.allowed).toEqual(["files", "mail-local"]);
  expect(defaultPolicy.models.allowed).toEqual(["ollama:*"]);
  expect(outcome.decision).toBe("deny");
  expect(outcome.reason).toBe("policy");
  expect(outcome.audit.reason).toBe("policy");
});

test("an action tagged deletes waits for approval when the grant is always", () => {
  const outcome = decide(
    {
      pluginId: "files",
      capability: "files.delete",
      scope: "/data/granted/row.csv",
      effects: ["deletes"],
      grants: [
        {
          capability: "files.delete",
          scope: "/data/granted",
          decision: "always",
        },
      ],
    },
    defaultPolicy,
    at,
  );

  expect(outcome.decision).toBe("needs-approval");
  expect(outcome.reason).toBe("deletes");
  expect(outcome.audit.effects).toEqual(["deletes"]);
});
