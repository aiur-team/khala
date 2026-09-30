// Test infrastructure only: handlers compose disposable adapters; never forward to a remote origin.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import os from 'node:os';
import path from 'node:path';

/** Private CA, loopback-only HTTPS and a bounded adapter request bridge. No request data is logged. */
export async function startRecoveryTransport({ handle }) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'khala-recovery-transport-'));
  chmodSync(directory, 0o700);
  const caFile = path.join(directory, 'ca.pem');
  const keyFile = path.join(directory, 'server.key');
  const certificateFile = path.join(directory, 'server.pem');
  const openssl = args => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore', timeout: 10_000 });
  let server;
  try {
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', caFile,
      '-days', '1', '-subj', '/CN=Khala disposable recovery CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', 'server.csr',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1']);
    openssl(['x509', '-req', '-in', 'server.csr', '-CA', caFile, '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', certificateFile, '-days', '1', '-copy_extensions', 'copy']);
    chmodSync(keyFile, 0o600);
    chmodSync(path.join(directory, 'ca.key'), 0o600);
    let origin;
    const counts = { requests: 0, completedAdapterResponses: 0, droppedRedeemResponses: 0 };
    server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certificateFile),
      requestTimeout: 10_000, headersTimeout: 10_000 }, async (incoming, outgoing) => {
      try {
        // All URLs are reconstructed under this listener. Absolute-form targets and host spoofing are refused.
        if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')
          || incoming.headers.host !== new URL(origin).host) {
          outgoing.writeHead(400).end(); return;
        }
        const parts = []; let length = 0;
        for await (const part of incoming) {
          length += part.length;
          if (length > 65_536) { outgoing.writeHead(413).end(); return; }
          parts.push(part);
        }
        const method = incoming.method ?? 'GET';
        const request = new Request(origin + incoming.url, { method, headers: incoming.headers,
          ...(['GET', 'HEAD'].includes(method) ? {} : { body: Buffer.concat(parts) }) });
        counts.requests += 1;
        const response = await handle(request);
        // The adapter must return only after its durable commit. Read fully before deciding to drop.
        const body = Buffer.from(await response.arrayBuffer());
        counts.completedAdapterResponses += 1;
        if (method === 'POST' && new URL(request.url).pathname === '/api/agent/channel-access/redeem'
          && response.status === 200 && counts.droppedRedeemResponses === 0) {
          let admitted = false;
          try { admitted = JSON.parse(body).kind === 'admitted'; } catch { /* Malformed responses are delivered. */ }
          if (admitted) {
            counts.droppedRedeemResponses += 1;
            incoming.socket.destroy();
            return;
          }
        }
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(body);
      } catch {
        if (!outgoing.headersSent) outgoing.writeHead(503, { 'content-type': 'application/json' });
        outgoing.end(JSON.stringify({ kind: 'unavailable' }));
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `https://127.0.0.1:${server.address().port}`;
    return {
      origin, caFile,
      receipt: () => ({ v: 1, scope: 'transport_only', ...counts }),
      async close() {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch {
    server?.closeAllConnections(); server?.close();
    rmSync(directory, { recursive: true, force: true });
    throw new Error('recovery_transport_start_failed');
  }
}
