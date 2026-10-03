import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { once } from 'node:events';

if (process.argv[2] === 'matrix') {
  await import('matrix-js-sdk');
  console.log(JSON.stringify({ ok: true }));
} else {
  const failures = [];
  async function fails(name, call) {
    try { await call(); throw new Error(`${name} was not blocked`); }
    catch (error) { assert.equal(error.code ?? error.cause?.code, 'KHALA_EGRESS_BLOCKED', name); failures.push(name); }
  }
  const socketFailure = create => new Promise((resolve, reject) => {
    const socket = create();
    socket.once('error', error => { socket.destroy(); reject(error); });
    socket.once('connect', () => { socket.destroy(); resolve(); });
  });
  for (const host of ['192.0.2.1', 'khala.invalid', '0.0.0.0']) {
    await fails('fetch:' + host, () => fetch(`http://${host}:443`));
    await fails('https:' + host, () => fetch(`https://${host}:443`));
    await fails('http:' + host, () => new Promise((resolve, reject) => http.get(`http://${host}:443`, resolve).once('error', reject)));
    await fails('net:' + host, () => socketFailure(() => net.connect(443, host)));
    await fails('socket:' + host, () => socketFailure(() => new net.Socket().connect({ host, port: 443 })));
    await fails('tls:' + host, () => socketFailure(() => tls.connect({ host, port: 443 })));
    for (const method of ['send', 'connect']) {
      const socket = dgram.createSocket('udp4');
      try { await fails('udp-' + method + ':' + host, () => new Promise((resolve, reject) => {
        const cb = error => error ? reject(error) : resolve();
        if (method === 'send') socket.send('probe', 443, host, cb);
        else { socket.once('error', reject); socket.connect(443, host, cb); }
      })); } finally { try { socket.close(); } catch { /* blocked before binding */ } }
    }
    for (const send of [socket => socket.send(Buffer.from('probe'), 0, 5, 443, host), socket => socket.send([Buffer.from('probe')], 443, host)]) {
      const socket = dgram.createSocket('udp4');
      try { await fails('udp-overload:' + host, () => new Promise((_resolve, reject) => {
        socket.once('error', reject); send(socket);
      })); } finally { try { socket.close(); } catch { /* blocked before binding */ } }
    }
    await fails('dns:' + host, () => new Promise((resolve, reject) => dns.lookup(host, error => error ? reject(error) : resolve())));
    await fails('promises.lookup:' + host, () => dns.promises.lookup(host));
    await fails('resolve4:' + host, () => dns.promises.resolve4(host));
    await fails('resolver:' + host, () => new dns.promises.Resolver().resolve4(host));
    await fails('reverse:' + host, () => dns.promises.reverse(host));
  }
  for (const host of ['127.0.0.999', '127.0.0.1.evil', '::ffff:192.0.2.1']) {
    await fails('invalid-loopback:' + host, () => socketFailure(() => net.connect({ host, port: 443 })));
  }
  await fails('custom-lookup', () => socketFailure(() => net.connect({ host: 'localhost', port: 443,
    lookup: (_host, options, callback) => callback(null, options.all ? [{ address: '192.0.2.1', family: 4 }] : '192.0.2.1', 4) })));
  for (const constructor of [dgram.createSocket, options => new dgram.Socket(options)]) {
    const socket = constructor({ type: 'udp4', lookup: (_host, _options, callback) => callback(null, '192.0.2.1', 4) });
    try { await fails('udp-custom-lookup', () => new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.send('probe', 443, 'localhost', error => error ? reject(error) : resolve());
    })); } finally { try { socket.close(); } catch { /* never bound */ } }
  }
  for (const Resolver of [dns.Resolver, dns.promises.Resolver]) {
    const resolver = new Resolver();
    resolver.setServers(['192.0.2.1']);
    await fails('loopback-query-remote-resolver', () => Resolver === dns.Resolver
      ? new Promise((resolve, reject) => resolver.resolve4('localhost', error => error ? reject(error) : resolve()))
      : resolver.resolve4('localhost'));
  }
  const server = http.createServer((_req, res) => res.end('loopback'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'loopback');
    for (const host of ['LOCALHOST', '127.0.0.2', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', undefined]) {
      if (host !== undefined) assert.ok((await dns.promises.lookup(host)).address);
      try { await socketFailure(() => net.connect({ host, port: server.address().port })); }
      catch (error) { assert.notEqual(error.code, 'KHALA_EGRESS_BLOCKED'); }
    }
  }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const udp = dgram.createSocket('udp4');
  try { await new Promise((resolve, reject) => {
    udp.once('error', reject);
    udp.send('loopback', 443, '127.0.0.1', error => error ? reject(error) : resolve());
  }); } finally { udp.close(); }
  console.log(JSON.stringify({ ok: true, failures }));
}
