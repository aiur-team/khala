import { readFile } from 'node:fs/promises';
import { assessNativeQueue, type NativeQueueReport } from './acceptance.ts';

const path = process.argv[2];
if (!path) throw new Error('usage: node verify.ts <report.json>');
const report = JSON.parse(await readFile(path, 'utf8')) as NativeQueueReport;
const verdict = assessNativeQueue(report);
console.log(JSON.stringify(verdict, null, 2));
if (verdict.failures.length > 0) process.exitCode = 1;
