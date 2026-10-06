#!/usr/bin/env node
// Scratch stdio MCP server for spike MH-U20. No dependencies: newline-delimited JSON-RPC.
// Exposes one tool, `probe`, whose schema declares an optional `khala_session` arg.
// Every tools/call logs the exact arguments it received to $SPIKE_LOG.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = (type, data) => {
  if (!process.env.SPIKE_LOG) return;
  appendFileSync(process.env.SPIKE_LOG, JSON.stringify({ at: new Date().toISOString(), src: "mcp", type, ppid: process.ppid, ...data }) + "\n");
};
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

log("mcp.start", { env_has_session: Boolean(process.env.KHALA_SESSION) });
createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "khala-spike", version: "0.0.1" } } });
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: [{
      name: "probe",
      description: "Spike probe tool. Call it with a short note.",
      inputSchema: { type: "object", properties: {
        note: { type: "string", description: "Any short note" },
        khala_session: { type: "string", description: "Set automatically by the plugin; leave empty" },
      }, required: ["note"] },
    }] } });
  } else if (method === "tools/call") {
    log("mcp.tools.call", { name: params?.name, arguments: params?.arguments });
    const s = params?.arguments?.khala_session;
    send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `probe ok; server saw khala_session=${s ?? "<absent>"}` }] } });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } });
  }
});
