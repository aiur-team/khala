// MH-U23 spike extension: waits for a trigger file, then calls session.send({prompt, mode:'enqueue'})
// while the TUI is idle, and logs timings and session events.
import { joinSession } from "@github/copilot-sdk/extension";
import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";

const LOG = "/tmp/claude-1000/spike-1114/logs/extension.ndjson";
const TRIGGER = "/tmp/claude-1000/spike-1114/trigger";
const log = (o) => appendFileSync(LOG, JSON.stringify({ ts: Date.now() / 1000, ...o }) + "\n");

log({ msg: "extension process started", pid: process.pid, env: Object.keys(process.env).filter((k) => /COPILOT|VSCODE/.test(k)) });

const session = await joinSession({});
log({ msg: "joined", sessionId: session.sessionId });

session.on((ev) => {
  if (/^(user\.message|assistant\.turn_start|assistant\.turn_end|session\.idle|assistant\.message)$/.test(ev.type)) {
    log({ msg: "event", type: ev.type, content: ev.data?.content?.slice?.(0, 120) });
  }
});

setInterval(async () => {
  if (!existsSync(TRIGGER)) return;
  const nonce = readFileSync(TRIGGER, "utf8").trim();
  unlinkSync(TRIGGER);
  const prompt = `Khala spike ${nonce}: reply with the single word OK and do nothing else.`;
  log({ msg: "send start", nonce });
  try {
    const id = await session.send({ prompt, mode: "enqueue" });
    log({ msg: "send admitted", nonce, messageId: id });
  } catch (e) {
    log({ msg: "send error", nonce, error: String(e?.stack || e) });
  }
}, 200);
