import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
if (rustc.status !== 0) {
  console.error(rustc.stderr || "rustc failed");
  process.exit(1);
}

const triple = /^host: (.+)$/m.exec(rustc.stdout)?.[1];
if (!triple) {
  console.error("rustc did not report a host target");
  process.exit(1);
}

const bunTargets: Record<string, string> = {
  "x86_64-pc-windows-msvc": "bun-windows-x64",
  "aarch64-pc-windows-msvc": "bun-windows-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64",
  "aarch64-unknown-linux-gnu": "bun-linux-arm64",
};
const target = bunTargets[triple];
if (!target) {
  console.error(`no agent host compile target for ${triple}`);
  process.exit(1);
}

const extension = triple.includes("windows") ? ".exe" : "";
const outDir = join(root, "apps/desktop/src-tauri/binaries");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, `agent-host-${triple}${extension}`);

const build = spawnSync(
  process.execPath,
  [
    "build",
    join(root, "packages/host/src/main.ts"),
    "--compile",
    `--target=${target}`,
    `--outfile=${outfile}`,
  ],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}
if (!existsSync(outfile)) {
  console.error(`agent host binary was not written to ${outfile}`);
  process.exit(1);
}
if (process.platform !== "win32") {
  chmodSync(outfile, 0o755);
}

console.log(`agent host binary: ${outfile}`);
