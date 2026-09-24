import { chmod, readFile, rename, writeFile } from "node:fs/promises"

const [operation, statePath, inputPath] = process.argv.slice(2)

if (!operation || !statePath) {
  throw new Error("usage: queue.mjs <initialize|enqueue|snapshot> <state-path> [input-path]")
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

if (operation === "initialize") {
  if (!inputPath) throw new Error("initialize requires an input fixture")
  await save(await load(inputPath))
} else if (operation === "enqueue") {
  if (!inputPath) throw new Error("enqueue requires an input batch")
  const state = await load(statePath)
  const input = await load(inputPath)
  state.mode = input.mode
  state.batches.push(input.batch)
  await save(state)
} else if (operation === "snapshot") {
  const state = await load(statePath)
  process.stdout.write(`${JSON.stringify({
    mode: state.mode,
    batchTokens: state.batches.map((batch) => batch.token),
    inFlightToken: state.inFlight?.token ?? null,
    inFlightStatus: state.inFlight?.status ?? null,
    acknowledgedTokens: state.acknowledgedTokens,
  }, null, 2)}\n`)
} else {
  throw new Error(`unknown operation: ${operation}`)
}
