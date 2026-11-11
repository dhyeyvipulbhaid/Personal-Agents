import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

test("the user installer checks the sha256 and only the user path", () => {
  const home = mkdtempSync(join(tmpdir(), "pa-install-"));
  const bundle = join(home, "bundle.bin");
  writeFileSync(bundle, "personal-agents-bundle");
  const sha = new Bun.CryptoHasher("sha256")
    .update("personal-agents-bundle")
    .digest("hex");

  if (process.platform === "win32") {
    const good = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "install.ps1"),
        "-Bundle",
        bundle,
        "-Sha",
        sha,
      ],
      { env: { ...process.env, PA_HOME: home, PA_OLLAMA_STATUS: "stopped" } },
    );
    if (good.status !== 0) {
      throw new Error(
        `installer failed\n${good.stdout.toString()}\n${good.stderr.toString()}`,
      );
    }
    expect(good.stdout.toString()).toContain("https://ollama.com/download");
    expect(readFileSync(join(home, "user-path.txt"), "utf8")).toContain(
      "Personal Agents",
    );

    const bad = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(root, "install.ps1"),
        "-Bundle",
        bundle,
        "-Sha",
        "00",
      ],
      { env: { ...process.env, PA_HOME: home, PA_OLLAMA_STATUS: "stopped" } },
    );
    expect(bad.status).not.toBe(0);
    expect(`${bad.stderr}${bad.stdout}`).toContain("sha256 mismatch");
    return;
  }

  const script = join(root, "install.sh");
  chmodSync(script, 0o755);
  const good = spawnSync(script, ["--file", bundle, "--sha", sha], {
    env: { ...process.env, PA_HOME: home, PA_OLLAMA_STATUS: "stopped" },
  });
  expect(good.status).toBe(0);
  expect(good.stdout.toString()).toContain("https://ollama.com/download");
  expect(readFileSync(join(home, ".profile"), "utf8")).toContain(
    'export PATH="$HOME/.local/bin:$PATH"',
  );
  expect(readFileSync(join(home, ".local/bin/personal-agents"), "utf8")).toBe(
    "personal-agents-bundle",
  );

  const bad = spawnSync(script, ["--file", bundle, "--sha", "00"], {
    env: { ...process.env, PA_HOME: home, PA_OLLAMA_STATUS: "stopped" },
  });
  expect(bad.status).not.toBe(0);
  expect(bad.stderr.toString()).toContain("sha256 mismatch");
}, 30_000);

test("the windows installer changes the user path and not the machine path", () => {
  const script = readFileSync(join(root, "install.ps1"), "utf8");
  expect(script).toContain('"User"');
  expect(script).not.toContain('"Machine"');
});
