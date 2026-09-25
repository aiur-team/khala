import { appendFile, chmod, readFile, rename, writeFile } from "node:fs/promises"

const [operation, statePath, inputPath] = process.argv.slice(2)
const logPath = process.env.KHALA_PROOF_LOG

if (!operation || !statePath) {
  throw new Error("usage: queue.mjs <initialize|reset|enqueue|mode|snapshot> <state-path> [input-path|mode]")
}

async function load(path) {
  return JSON.parse(await readFile(path, "utf8"))
}

async function save(value) {
  const temporary = `${statePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, statePath)
}

// Every queue operation is logged beside the plugin events so channel arrival
// times and resets are part of the same raw timeline.
async function record(type, fields) {
  if (!logPath) return
  const line = { wall: new Date().toISOString(), type, source: "queue.mjs", ...fields }
  await appendFile(logPath, `${JSON.stringify(line)}\n`, { mode: 0o600 })
}

function summary(state) {
  return {
    mode: state.mode,
    boundSessionID: state.boundSessionID ?? null,
    batchTokens: state.batches.map((batch) => batch.token),
    inFlightToken: state.inFlight?.token ?? null,
    inFlightStatus: state.inFlight?.status ?? null,
    acknowledgedTokens: state.acknowledgedTokens,
    steerPersistence: state.steerPersistence ?? "once",
    steerPlacement: state.steerPlacement ?? "tail-message",
  }
}

if (operation === "initialize") {
  if (!inputPath) throw new Error("initialize requires an input fixture")
  const state = await load(inputPath)
  await save(state)
  await record("channel.initialized", summary(state))
} else if (operation === "reset") {
  // Clears batches, lease, and acknowledgements but keeps the admitted session.
  const state = await load(statePath)
  const before = summary(state)
  state.batches = []
  state.inFlight = null
  state.acknowledgedTokens = []
  await save(state)
  await record("channel.reset", { before, after: summary(state) })
} else if (operation === "mode") {
  const state = await load(statePath)
  const [mode, persistence, placement] = inputPath.split(":")
  state.mode = mode
  if (persistence) state.steerPersistence = persistence
  if (placement) state.steerPlacement = placement
  await save(state)
  await record("channel.mode", summary(state))
} else if (operation === "enqueue") {
  if (!inputPath) throw new Error("enqueue requires an input batch")
  const state = await load(statePath)
  const input = await load(inputPath)
  if (state.batches.some((batch) => batch.token === input.batch.token)) {
    throw new Error(`token ${input.batch.token} already used; tokens are single-use per trial`)
  }
  state.mode = input.mode
  state.batches.push(input.batch)
  await save(state)
  await record("channel.enqueued", { mode: input.mode, token: input.batch.token, ...summary(state) })
} else if (operation === "snapshot") {
  const state = await load(statePath)
  await record("channel.snapshot", summary(state))
  process.stdout.write(`${JSON.stringify(summary(state), null, 2)}\n`)
} else {
  throw new Error(`unknown operation: ${operation}`)
}
