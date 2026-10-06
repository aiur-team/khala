import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConformanceResult } from './run';

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const cell = (value: string) => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
export function renderConformanceReport(results: readonly ConformanceResult[]): string {
  const features = [...new Set(results.flatMap(result => result.rows.map(row => row.feature)))];
  return [
    '# Multi-harness Tier A conformance', '',
    'In-process client and hook checks against fake transport boundaries. Pending is execution-order debt, not verified parity.', '',
    `| Feature | ${results.map(result => cell(result.harness)).join(' | ')} |`,
    `| --- | ${results.map(() => '---').join(' | ')} |`,
    ...features.map(feature => `| ${feature} | ${results.map(result => {
      const row = result.rows.find(row => row.feature === feature);
      return row ? cell(row.status === 'pending' ? `PENDING — ${row.detail}` : row.status === 'absent' ? 'ABSENT (asserted)' : 'PASS') : 'NOT RUN';
    }).join(' | ')} |`), '',
  ].join('\n');
}

/** One complete matrix per run, never one harness overwriting another's report. */
export async function writeConformanceReport(results: readonly ConformanceResult[],
  options: { env?: NodeJS.ProcessEnv; root?: string } = {}): Promise<string | undefined> {
  if ((options.env ?? process.env).KHALA_CONFORMANCE_REPORT !== '1') return undefined;
  const target = path.join(options.root ?? repositoryRoot, 'docs/evidence/multi-harness/conformance.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, renderConformanceReport(results));
  return target;
}
