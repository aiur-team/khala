// Loaded by the private canary only. A native model process may contact its
// provider; Khala's Node transport may connect only to loopback listeners.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const entry = process.argv[1] || '';
const isKhala = path.basename(entry) === 'khala' || path.basename(entry) === 'khala.js'
  || path.basename(entry) === 'khala-internal.js'
  || entry.includes('/khala/versions/') || entry.includes('/plugins/khala/hooks/');
if (isKhala) {
  const allowed = host => host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = args[0];
    const host = first && typeof first === 'object' ? first.host ?? first.hostname ?? 'localhost'
      : typeof first === 'number' ? typeof args[1] === 'string' ? args[1] : 'localhost' : null;
    if (host !== null && !allowed(host)) {
      try { fs.appendFileSync(process.env.KHALA_INTERNAL_CANARY_DENIAL_FILE, 'denied\n'); } catch { /* fail remains typed */ }
      throw new Error('internal_canary_network_denied');
    }
    return original.apply(this, args);
  };
}
