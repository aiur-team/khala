// Scratch OpenCode plugin for spike MH-U20 (#1113). Deleted before U37.
// Logs every hook it sees to $SPIKE_LOG and runs one-shot experiments driven by
// control files in $SPIKE_DIR:
//   inject  = "noreply" | "async"  -> on the next `bash` tool.execute.before, inject a user message
//   wake                           -> on the next session.idle, promptAsync a wake turn (no noReply)
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = process.env.SPIKE_DIR ?? "/tmp";
const log = (type, data = {}) => {
  if (!process.env.SPIKE_LOG) return;
  appendFileSync(process.env.SPIKE_LOG, JSON.stringify({ at: new Date().toISOString(), src: "plugin", type, ...data }) + "\n");
};
const take = (name) => {
  const p = join(DIR, name);
  if (!existsSync(p)) return null;
  const v = readFileSync(p, "utf8").trim();
  rmSync(p);
  return v || name;
};

const server = async ({ client, directory, serverUrl }, options) => {
  log("plugin.init", { pid: process.pid, here, directory, serverUrl: String(serverUrl), options });
  return {
    config: async (cfg) => {
      cfg.mcp = {
        ...(cfg.mcp ?? {}),
        khala: { type: "local", command: ["node", join(here, "mcp-server.mjs")], environment: { SPIKE_LOG: process.env.SPIKE_LOG ?? "" }, enabled: true },
      };
      log("hook.config", { mcpKeys: Object.keys(cfg.mcp) });
    },
    "tool.execute.before": async (input, output) => {
      log("hook.tool.before", { tool: input.tool, sessionID: input.sessionID, args: output.args });
      if (input.tool.startsWith("khala_")) {
        output.args.khala_session = input.sessionID;
        log("stamp.khala_session", { tool: input.tool, sessionID: input.sessionID });
      }
      if (input.tool === "bash") {
        const mode = take("inject");
        if (mode === "noreply") {
          const r = await client.session.promptAsync({ path: { id: input.sessionID }, body: { noReply: true, parts: [{ type: "text", text: "NOREPLY-7731: in your next reply, include the codeword PELICAN." }] } });
          log("inject.noreply", { status: r.response?.status, error: r.error ?? null });
        } else if (mode === "async") {
          const r = await client.session.promptAsync({ path: { id: input.sessionID }, body: { parts: [{ type: "text", text: "QUEUED-5512: reply with exactly QUEUED-ACK and nothing else." }] } });
          log("inject.async", { status: r.response?.status, error: r.error ?? null });
        }
      }
    },
    "tool.execute.after": async (input) => log("hook.tool.after", { tool: input.tool, sessionID: input.sessionID }),
    "chat.message": async (input, output) => {
      log("hook.chat.message", { sessionID: input.sessionID, messageID: input.messageID, parts: (output.parts ?? []).map((p) => ({ type: p.type, text: p.text, synthetic: p.synthetic })) });
    },
    event: async ({ event }) => {
      if (!event.type.startsWith("session.") || event.type === "session.diff") return;
      log("event", { type: event.type, properties: event.type === "session.updated" ? undefined : event.properties });
      const wake = event.type === "session.idle" ? take("wake") : null;
      if (wake) {
        const id = event.properties.sessionID;
        // "synth-only": one synthetic part, to see whether the model receives it and what the TUI shows.
        const parts = wake === "synth-only"
          ? [{ type: "text", text: "WAKE-SYNTHONLY-9902: reply with exactly SYNTHONLY-ACK and nothing else.", synthetic: true }]
          : [
              { type: "text", text: "WAKE-VISIBLE-4410: reply with exactly WAKE-ACK and nothing else." },
              { type: "text", text: "WAKE-SYNTH-4410 (synthetic part)", synthetic: true },
            ];
        const r = await client.session.promptAsync({ path: { id }, body: { parts } });
        log("wake.promptAsync", { sessionID: id, status: r.response?.status, error: r.error ?? null });
      }
    },
  };
};

export default { id: "khala-opencode-spike", server };
