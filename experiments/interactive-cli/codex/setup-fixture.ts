import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const [codexHome, fixtureDir] = process.argv.slice(2);
if (!codexHome || !fixtureDir) throw new Error("usage: setup-fixture.ts <codex-home> <fixture-dir>");

const bridge = resolve("experiments/interactive-cli/codex/bridge.ts");
const command = `node ${JSON.stringify(bridge)} hook`;
const handler = { type: "command", command, timeout: 30, additionalContextLimit: 0 };
const stopHandler = { type: "command", command, timeout: 30 };
const hooks = {
  hooks: {
    PreToolUse: [{ hooks: [handler] }],
    PostToolUse: [{ hooks: [handler] }],
    UserPromptSubmit: [{ hooks: [handler] }],
    Stop: [{ hooks: [stopHandler] }]
  }
};

await mkdir(codexHome, { recursive: true, mode: 0o700 });
await mkdir(fixtureDir, { recursive: true, mode: 0o700 });
await writeFile(`${codexHome}/hooks.json`, `${JSON.stringify(hooks, null, 2)}\n`, { mode: 0o600 });
await writeFile(`${fixtureDir}/mode`, "async\n", { mode: 0o600 });
console.log(JSON.stringify({ codexHome, fixtureDir, bridge, hooks: Object.keys(hooks.hooks) }));
