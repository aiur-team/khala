import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Writes the proof hooks into a project's `.codex` config layer and the skill
// stand-in into its AGENTS.md. Codex still asks the human to trust the project
// and review the hooks in the TUI; nothing here bypasses either prompt.
const [project] = process.argv.slice(2);
if (!project) throw new Error("usage: setup-fixture.ts <project-dir>");
const configDir = resolve(project, ".codex");
const fixtureDir = resolve(project, ".khala-fixture");

const bridge = resolve(import.meta.dirname, "bridge.ts");
const command = `KHALA_FIXTURE_DIR=${JSON.stringify(fixtureDir)} node ${JSON.stringify(bridge)} hook`;
const handler = { type: "command", command, timeout: 30 };
const hooks = {
  hooks: {
    PreToolUse: [{ hooks: [handler] }],
    PostToolUse: [{ hooks: [handler] }],
    UserPromptSubmit: [{ hooks: [handler] }],
    Stop: [{ hooks: [handler] }]
  }
};

await mkdir(configDir, { recursive: true, mode: 0o700 });
await mkdir(fixtureDir, { recursive: true, mode: 0o700 });
await writeFile(`${configDir}/hooks.json`, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
await writeFile(`${fixtureDir}/mode`, "async\n", { mode: 0o600 });
const agents = (await readFile(resolve(import.meta.dirname, "AGENTS.proof.md"), "utf8"))
  .replaceAll("KHALA_READ", `KHALA_FIXTURE_DIR=${JSON.stringify(fixtureDir)} node ${JSON.stringify(bridge)} read`);
await writeFile(resolve(project, "AGENTS.md"), agents, { mode: 0o600 });
console.log(JSON.stringify({ configDir, fixtureDir, bridge, hooks: Object.keys(hooks.hooks) }));
