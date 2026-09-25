import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const RECORD_KIND = 'opencode-delivery-route/v1';
const IN_PROCESS_ROUTE = 'in_process_plugin';

export function verifyRoute(record) {
  if (record?.kind !== RECORD_KIND) {
    throw new Error(`unsupported record kind: ${record?.kind ?? 'missing'}`);
  }

  if (record.opencodeVersion !== '1.17.10') {
    throw new Error(`unsupported OpenCode version: ${record.opencodeVersion ?? 'missing'}`);
  }

  // Guarded predicate: removing it admits external embedded-server clients.
  if (record.route?.transport !== IN_PROCESS_ROUTE || record.route.client !== 'plugin_sdk_client' || record.route.server !== 'none' || record.route.externalClient !== false) throw new Error('delivery route must use the in-process plugin client');

  if (record.khalaLaunchedServer !== false) {
    throw new Error('Khala must not launch an OpenCode server');
  }

  return record;
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) throw new Error('usage: node verify-route.mjs <record.json> [...]');

  for (const path of paths) {
    const record = JSON.parse(await readFile(path, 'utf8'));
    verifyRoute(record);
    process.stdout.write(`accepted ${path}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
