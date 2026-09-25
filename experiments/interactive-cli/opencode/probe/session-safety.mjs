import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const scratch = await mkdtemp(join(tmpdir(), "interactive-opencode-safety-"))
const statePath = join(scratch, "state.json")
const logPath = join(scratch, "events.jsonl")

process.env.KHALA_PROOF_STATE = statePath
process.env.KHALA_PROOF_LOG = logPath

const { KhalaProof } = await import(pathToFileURL(
  new URL("./workspace/.opencode/plugins/khala-proof.js", import.meta.url).pathname,
))

const batch = (token) => ({
  token,
  messages: [{
    id: `message-${token}`,
    channel: "interactive-opencode-safety",
    sender: "proof-peer",
    text: `nonce for ${token}`,
  }],
})

async function reset(mode, batches) {
  await writeFile(statePath, `${JSON.stringify({
    mode,
    batches,
    boundSessionID: "session-A",
    inFlight: null,
    acknowledgedTokens: [],
  }, null, 2)}\n`, { mode: 0o600 })
}

async function state() {
  return JSON.parse(await readFile(statePath, "utf8"))
}

let rejectPrompt = false
const promptCalls = []
const plugin = await KhalaProof({
  directory: "/proof/workspace",
  client: {
    session: {
      promptAsync: async (request) => {
        promptCalls.push(request)
        if (rejectPrompt) throw new Error("synthetic prompt rejection")
      },
    },
  },
})

try {
  await reset("sync", [batch("sync-1"), batch("sync-2")])
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-B" } } })
  assert.equal(promptCalls.length, 0)
  assert.equal((await state()).inFlight, null)

  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-A" } } })
  assert.equal(promptCalls.length, 1)
  assert.deepEqual((await state()).inFlight, {
    token: "sync-1",
    sessionID: "session-A",
    status: "delivered",
  })

  await assert.rejects(
    plugin.tool.khala_send.execute({ response: "wrong-session" }, { sessionID: "session-B" }),
    /non-admitted session/,
  )
  assert.equal((await state()).inFlight.token, "sync-1")

  await plugin.tool.khala_send.execute({ response: "ack-sync-1" }, { sessionID: "session-A" })
  await plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-A" } } })
  assert.equal(promptCalls.length, 2)
  assert.equal((await state()).inFlight.token, "sync-2")

  await reset("sync", [batch("sync-rejected")])
  rejectPrompt = true
  await assert.rejects(
    plugin.event({ event: { type: "session.idle", properties: { sessionID: "session-A" } } }),
    /synthetic prompt rejection/,
  )
  assert.equal((await state()).inFlight.status, "uncertain")
  await plugin.tool.khala_send.execute({ response: "must-not-ack" }, { sessionID: "session-A" })
  assert.equal((await state()).inFlight.token, "sync-rejected")
  assert.deepEqual((await state()).acknowledgedTokens, [])
  rejectPrompt = false

  await reset("async", [batch("async-1")])
  await assert.rejects(
    plugin.tool.khala_read.execute({}, { sessionID: "session-B" }),
    /non-admitted session/,
  )
  assert.equal((await state()).inFlight, null)
  await plugin.tool.khala_read.execute({}, { sessionID: "session-A" })
  assert.equal((await state()).inFlight.status, "delivered")

  await reset("steer", [batch("steer-1")])
  await plugin["tool.execute.after"]({
    sessionID: "session-A",
    tool: "proof_gate",
    callID: "call-1",
    args: { stage: 1 },
  })
  const draft = "PREFILLED-DRAFT-MUST-STAY-BYTE-FOR-BYTE"
  const wrongSessionMessages = [{
    info: { role: "user", sessionID: "session-B" },
    parts: [{ type: "text", text: draft }],
  }]
  await plugin["experimental.chat.messages.transform"]({}, { messages: wrongSessionMessages })
  assert.equal(wrongSessionMessages[0].parts[0].text, draft)
  assert.equal((await state()).inFlight.status, "leased")

  const admittedMessages = [{
    info: { role: "user", sessionID: "session-A" },
    parts: [{ type: "text", text: "continue original turn" }],
  }]
  await plugin["experimental.chat.messages.transform"]({}, { messages: admittedMessages })
  assert.equal(admittedMessages[0].parts[0].text, "continue original turn")
  assert.match(admittedMessages[1].parts[0].text, /khala\.channel\.batch/)
  assert.equal((await state()).inFlight.status, "delivered")

  process.stdout.write(`${JSON.stringify({
    result: "PASS",
    checks: [
      "wrong-session idle leaves the batch pending",
      "wrong-session send cannot acknowledge another session's lease",
      "a later same-session batch remains eligible",
      "failed prompt submission remains uncertain and unacknowledged",
      "wrong-session async read fails closed",
      "wrong-session transform preserves the prefilled text byte-for-byte",
    ],
  }, null, 2)}\n`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
