import { readdir, readFile, writeFile } from "node:fs/promises";

// Polls every process during a live trial. Markers arrive on stdin so they never
// appear in this watcher's own argv. Records every live Khala hook, read, and
// `codex queue` wake process it sees, and any process whose argv or environment
// contains a marker.
const [output, seconds = "120"] = process.argv.slice(2);
if (!output) throw new Error("usage: watch-proc.ts <output.json> [seconds] < markers");

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const markers = Buffer.concat(chunks).toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
if (markers.length === 0) throw new Error("at least one marker is required on stdin");

interface Seen {
  pid: number;
  firstSeenAt: string;
  kind: string;
  commandLine: string[];
  commandLineMarkerMatch: boolean;
  environmentMarkerMatch: boolean;
}

const observed = new Map<number, Seen>();
const markerHits: Seen[] = [];
let scans = 0;
const deadline = Date.now() + Number(seconds) * 1000;

function kind(argv: string[]): string | undefined {
  const joined = argv.join(" ");
  if (joined.includes("bridge.ts") && argv.includes("hook")) return "hook";
  if (joined.includes("bridge.ts") && argv.includes("read")) return "read";
  if (joined.includes("bridge.ts") && argv.includes("enqueue")) return "enqueue";
  if (argv.some((value) => value.endsWith("codex") || value.endsWith("codex.js")) && argv.includes("queue")) {
    return "queue-wake";
  }
  return undefined;
}

while (Date.now() < deadline) {
  scans += 1;
  for (const entry of await readdir("/proc")) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid || observed.has(pid)) continue;
    let argv: string[];
    let environment: string;
    try {
      argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
      environment = await readFile(`/proc/${pid}/environ`, "utf8");
    } catch {
      continue;
    }
    const commandLineMarkerMatch = markers.some((marker) => argv.some((value) => value.includes(marker)));
    const environmentMarkerMatch = markers.some((marker) => environment.includes(marker));
    const processKind = kind(argv);
    if (!processKind && !commandLineMarkerMatch && !environmentMarkerMatch) continue;
    const seen = {
      pid,
      firstSeenAt: new Date().toISOString(),
      kind: processKind ?? "other",
      commandLine: argv,
      commandLineMarkerMatch,
      environmentMarkerMatch
    };
    observed.set(pid, seen);
    if (commandLineMarkerMatch || environmentMarkerMatch) markerHits.push(seen);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
}

const processes = [...observed.values()];
await writeFile(output, `${JSON.stringify({
  finishedAt: new Date().toISOString(),
  scans,
  markerCount: markers.length,
  processCounts: Object.fromEntries(["hook", "read", "enqueue", "queue-wake", "other"].map((name) =>
    [name, processes.filter((item) => item.kind === name).length])),
  markerHits,
  processes
}, null, 2)}\n`, { mode: 0o600 });
