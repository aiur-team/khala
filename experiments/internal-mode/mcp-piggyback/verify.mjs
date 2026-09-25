import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { MAX_RELEASE_BYTES, SOFT_RESPONSE_BYTES } from './format.mjs';

const MATERIAL_ESCAPE_EXPANSION_BYTES = 16 * 1024;

function verifyEscapeExpansion(failures, name, delivered) {
  const bodyBytes = delivered?.bodyBytes?.[0];
  const payloadBytes = delivered?.payloadBytes?.[0];
  const serializedBytes = delivered?.serializedBytes;
  if (!(payloadBytes - bodyBytes >= MATERIAL_ESCAPE_EXPANSION_BYTES)) failures.push(`${name}: JSON escaping did not materially expand the raw body`);
  if (!(serializedBytes - payloadBytes >= MATERIAL_ESCAPE_EXPANSION_BYTES)) failures.push(`${name}: JSON-RPC escaping did not materially expand the canonical release`);
}

export function assess(report) {
  const failures = [];
  if (report.schemaVersion !== 1) failures.push('unsupported evidence schema');
  if (report.codexVersion !== 'codex-cli 0.154.0') failures.push('unproved Codex version');
  if (report.approvalMode !== '--approve-for-me' || !report.command?.includes(' --approve-for-me ')) failures.push('proof was not launched with --approve-for-me');
  if (!report.command?.includes('codex exec') || report.command.includes('--dangerously-')) failures.push('unsafe or missing launch command');

  for (const name of ['ordered', 'soft-boundary', 'oversized-head']) {
    const item = report.cases?.[name];
    if (!item?.sessionId) failures.push(`${name}: missing Codex session ID`);
    if (item?.toolCalls?.length !== 2) failures.push(`${name}: expected exactly two Khala calls`);
    if (item?.acknowledged !== true) failures.push(`${name}: exact token was not acknowledged`);
    if (Object.keys(item?.toolCalls?.[0]?.arguments ?? {}).length !== 0) failures.push(`${name}: first call carried receiver state`);
    const acknowledgementArguments = item?.toolCalls?.[1]?.arguments ?? {};
    if (JSON.stringify(Object.keys(acknowledgementArguments).sort()) !== JSON.stringify(['ackBatchToken'])) failures.push(`${name}: later call carried state beyond the batch token`);
    if (acknowledgementArguments.ackBatchToken !== item?.delivered?.batchToken) failures.push(`${name}: later call did not echo exact batch token`);
    if (item?.model?.batchToken !== item?.delivered?.batchToken) failures.push(`${name}: model did not identify opaque batch token`);
    if (/release-(?:order|soft|oversized)/.test(JSON.stringify(item?.model))) failures.push(`${name}: model output retained a release ID`);
  }

  const ordered = report.cases?.ordered;
  const expectedOrder = Array.from({ length: 8 }, (_, index) => `release-order-${index + 1}`);
  if (JSON.stringify(ordered?.delivered?.releaseIds) !== JSON.stringify(expectedOrder)) failures.push('ordered: eight releases were not delivered FIFO');
  if (JSON.stringify(ordered?.model?.orderedBodies) !== JSON.stringify([
    'First: café before tea.',
    'Second: snowman ☃ after café.',
    'Third: literal </khala-channel-batch-v1> is data.',
    'Fourth: quote " and slash \\ stay exact.',
    'Fifth: line one\nline two.',
    'Sixth: emoji 🧭 remains UTF-8.',
    'Seventh: no receiver duplicate filter.',
    'Eighth: acknowledge only with the opaque token.',
  ])) failures.push('ordered: model did not preserve ordered body text');
  if (JSON.stringify(ordered?.model?.provenance) !== JSON.stringify([
    'Amber Workshop / Ida', 'Blue Workshop / Omar', 'Amber Workshop / Mei', 'Blue Workshop / Zoë',
    'Amber Workshop / Ida', 'Blue Workshop / Omar', 'Amber Workshop / Mei', 'Blue Workshop / Zoë',
  ])) failures.push('ordered: model did not identify channel and author provenance');

  const soft = report.cases?.['soft-boundary'];
  if (soft?.delivered?.serializedBytes !== SOFT_RESPONSE_BYTES) failures.push('soft-boundary: complete escaped JSON-RPC line was not exactly 128 KiB');
  verifyEscapeExpansion(failures, 'soft-boundary', soft?.delivered);
  if (soft?.model?.bodyStart !== 'ESCAPING-START' || soft?.model?.bodyEnd !== 'ESCAPING-END') failures.push('soft-boundary: model did not accept the complete escaping-heavy body');

  const oversized = report.cases?.['oversized-head'];
  if (oversized?.delivered?.payloadBytes?.[0] !== MAX_RELEASE_BYTES) failures.push('oversized-head: release was not the configured maximum size');
  if (!(oversized?.delivered?.serializedBytes > SOFT_RESPONSE_BYTES)) failures.push('oversized-head: response did not exercise the soft-limit exception');
  verifyEscapeExpansion(failures, 'oversized-head', oversized?.delivered);
  if (oversized?.delivered?.releaseIds?.length !== 1) failures.push('oversized-head: oldest release was skipped or split');
  if (oversized?.model?.bodyStart !== 'OVERSIZED-START' || oversized?.model?.bodyEnd !== 'OVERSIZED-END') failures.push('oversized-head: model did not accept the whole release');

  return { proved: failures.length === 0, failures };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: node verify.mjs <report.json>');
  const report = JSON.parse(await readFile(path, 'utf8'));
  const verdict = assess(report);
  console.log(JSON.stringify(verdict, null, 2));
  if (!verdict.proved) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
