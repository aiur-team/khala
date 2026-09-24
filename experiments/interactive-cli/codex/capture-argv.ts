import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const [output] = process.argv.slice(2);
const root = process.env.KHALA_FIXTURE_DIR;
if (!output || !root) throw new Error("usage: capture-argv.ts <output.json> with KHALA_FIXTURE_DIR");

const marker = "ARGV_SECRET_MARKER_164";
const child = spawn(process.execPath, [resolve("bridge.ts"), "enqueue"], {
  cwd: resolve("."),
  env: { ...process.env, KHALA_FIXTURE_DIR: root },
  stdio: ["pipe", "ignore", "pipe"]
});
assert.ok(child.pid);

const commandLine = (await readFile(`/proc/${child.pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
const environment = (await readFile(`/proc/${child.pid}/environ`, "utf8")).split("\0").filter(Boolean);
child.stdin.end(JSON.stringify({ mode: "async", token: "argv-probe", body: marker }));
const status = await new Promise<number | null>((resolveStatus) => child.once("exit", resolveStatus));
assert.equal(status, 0);

const evidence = {
  capturedAt: new Date().toISOString(),
  pid: child.pid,
  commandLine,
  marker,
  commandLineMarkerMatches: commandLine.filter((value) => value.includes(marker)),
  environmentMarkerMatches: environment.filter((value) => value.includes(marker)),
  messageTransport: "stdin pipe"
};
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
