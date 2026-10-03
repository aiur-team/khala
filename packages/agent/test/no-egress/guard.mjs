// This JavaScript guard covers public Node network APIs and permits only Node
// subprocesses inheriting this exact preload/log. Workers are blocked entirely.
// Known blind spots: native addons, process.binding('tcp_wrap') and other direct
// native handles can bypass these hooks. This is regression instrumentation,
// not an OS sandbox. Resolver instances are covered. Async denials emit errors;
// synchronous child APIs preserve their native error-return/throw contract.
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import * as module from 'node:module';
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';

const record = value => appendFileSync(process.env.KHALA_EGRESS_LOG, JSON.stringify({ v: 1, pid: process.pid, ...value }) + '\n');
const loopback = host => {
  if (host === undefined || host === null || host === '') return true;
  const value = String(host).toLowerCase();
  if (['localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1'].includes(value)) return true;
  const quad = value.replace(/^::ffff:/, '').split('.');
  return quad.length === 4 && quad[0] === '127' && quad.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};
const blocked = (kind, host, port = 0) => {
  process.stderr.write(`khala-egress-guard: blocked ${kind} ${host}:${port}\n`);
  return Object.assign(new Error('KHALA_EGRESS_BLOCKED'), { code: 'KHALA_EGRESS_BLOCKED' });
};
const nativeDnsLookup = dns.lookup;
function checkedLookup(lookup, fn) {
  return (hostname, options, callback) => lookup(hostname, options, (error, address, family) => {
    if (error) { callback(error); return; }
    const addresses = Array.isArray(address) ? address.map(value => value.address) : [address];
    const remote = addresses.find(value => !loopback(value) && !(fn === 'udp.lookup' && ['0.0.0.0', '::'].includes(hostname) && value === hostname));
    if (remote !== undefined) {
      record({ kind: 'dns', fn, host: String(remote), allowed: false });
      const denied = blocked('dns', remote);
      process.nextTick(() => callback(denied));
    } else callback(null, address, family);
  });
}
record({ kind: 'guard', event: 'installed', argv: process.argv.slice(1, 5).map((arg, i) => (i === 0 ? basename(arg) : arg).slice(0, 64)), node: process.version });
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node's net.connect passes its already-normalized arguments as an array.
  const values = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof values[0] === 'object' ? values[0] : typeof values[0] === 'string'
    ? { path: values[0] } : { port: values[0], host: typeof values[1] === 'string' ? values[1] : undefined };
  if (typeof options.path === 'string') {
    record({ kind: 'ipc', path: String(options.path), allowed: true });
    return connect.apply(this, args);
  }
  const host = options.host ?? 'localhost';
  const port = Number(options.port ?? 0);
  const allowed = loopback(host);
  record({ kind: 'tcp', host: String(host), port, allowed });
  if (allowed) {
    const checked = { ...options, lookup: checkedLookup(options.lookup ?? dns.lookup, 'socket.lookup') };
    return connect.apply(this, [checked, ...values.slice(1)]);
  }
  const error = blocked('tcp', host, port);
  this.connecting = true;
  process.nextTick(() => this.destroy(error));
  return this;
};
const NativeDatagramSocket = dgram.Socket;
function GuardedDatagramSocket(options, callback) {
  const opts = typeof options === 'string' ? { type: options } : options;
  // The wildcard lookup is UDP's automatic local bind, not a destination.
  const lookup = opts.lookup ?? ((host, lookupOptions, cb) =>
    ['0.0.0.0', '::'].includes(host) ? nativeDnsLookup(host, lookupOptions, cb) : dns.lookup(host, lookupOptions, cb));
  return new NativeDatagramSocket({ ...opts, lookup: checkedLookup(lookup, 'udp.lookup') }, callback);
}
GuardedDatagramSocket.prototype = NativeDatagramSocket.prototype;
Object.setPrototypeOf(GuardedDatagramSocket, NativeDatagramSocket);
dgram.Socket = GuardedDatagramSocket;
dgram.createSocket = (options, callback) => new GuardedDatagramSocket(options, callback);
for (const name of ['send', 'connect']) {
  const original = dgram.Socket.prototype[name];
  dgram.Socket.prototype[name] = function (...args) {
    let host, port;
    if (name === 'connect') { port = args[0]; host = typeof args[1] === 'string' ? args[1] : undefined; }
    else {
      let remote;
      try { remote = this.remoteAddress(); } catch { /* Socket is unconnected. */ }
      if (remote) { port = remote.port; host = remote.address; }
      else {
        const offsetForm = typeof args[1] === 'number' && typeof args[2] === 'number' && typeof args[3] === 'number';
        port = args[offsetForm ? 3 : 1];
        host = typeof args[offsetForm ? 4 : 2] === 'string' ? args[offsetForm ? 4 : 2] : 'localhost';
      }
    }
    host ??= 'localhost';
    const allowed = loopback(host);
    record({ kind: 'udp', host: String(host), port: Number(port ?? 0), allowed });
    if (allowed) return original.apply(this, args);
    const error = blocked('udp', host, port);
    const callback = typeof args.at(-1) === 'function' ? args.at(-1) : undefined;
    process.nextTick(() => name === 'send' && callback ? callback(error) : this.emit('error', error));
    return undefined;
  };
}
function patchDns(target, prefix) {
  for (const name of Object.getOwnPropertyNames(target).filter(key => key === 'lookup' || key === 'lookupService' || key === 'reverse' || key.startsWith('resolve'))) {
    if (typeof target[name] !== 'function') continue;
    const original = target[name];
    target[name] = function (...args) {
      const host = args[0];
      const allowed = loopback(host);
      record({ kind: 'dns', fn: prefix + name, host: String(host ?? 'localhost'), allowed });
      if (allowed && name === 'lookupService') {
        // getnameinfo uses OS/NSS resolver configuration, not c-ares servers.
        const result = { hostname: String(host), service: String(args[1]) };
        if (prefix) return Promise.resolve(result);
        const callback = args.at(-1);
        process.nextTick(() => { if (typeof callback === 'function') callback(null, result.hostname, result.service); });
        return undefined;
      }
      let deniedHost = host;
      if (allowed && name !== 'lookup') {
        // c-ares bypasses JavaScript sockets. Check its actual resolver
        // destinations, even when the requested name/address is loopback.
        const servers = typeof this?.getServers === 'function' ? this.getServers() : dns.getServers();
        const remote = servers.map(server => server.startsWith('[') ? server.slice(1, server.indexOf(']')) : server.replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1'))
          .find(server => !loopback(server));
        if (remote === undefined) return original.apply(this, args);
        deniedHost = remote;
        record({ kind: 'dns', fn: prefix + name + '.server', host: remote, allowed: false });
      } else if (allowed) {
        // Accepted lookup targets are literals or localhost. Resolve locally so
        // unusual NSS/hosts configuration cannot emit a DNS packet externally.
        const value = String(host ?? 'localhost').toLowerCase();
        const options = typeof args[1] === 'object' ? args[1] : { family: args[1] };
        const address = value === 'localhost' || value === ''
          ? options?.family === 6 ? '::1' : '127.0.0.1'
          : value.includes(':') ? value === '[::1]' ? '::1' : value : value.split('.').map(Number).join('.');
        const family = address.includes(':') ? 6 : 4;
        const result = { address, family };
        if (prefix) return Promise.resolve(options?.all ? [result] : result);
        const callback = args.at(-1);
        process.nextTick(() => { if (typeof callback === 'function') {
          if (options?.all) callback(null, [result]); else callback(null, address, family);
        } });
        return undefined;
      }
      const error = blocked('dns', deniedHost);
      if (prefix) return Promise.reject(error);
      const callback = args.at(-1);
      process.nextTick(() => { if (typeof callback === 'function') callback(error); });
      return undefined;
    };
  }
}
patchDns(dns, '');
patchDns(dns.promises, 'promises.');
// Resolver instances bypass the top-level DNS convenience functions.
patchDns(dns.Resolver.prototype, '');
patchDns(dns.promises.Resolver.prototype, 'promises.');
workerThreads.Worker = class BlockedWorker extends EventEmitter {
  constructor() {
    super();
    record({ kind: 'worker', allowed: false });
    const error = blocked('worker', 'worker');
    process.nextTick(() => this.emit('error', error));
  }
  ref() { return this; }
  unref() { return this; }
  async terminate() { return 0; }
};
function safeNodeArgs(args) {
  // Permit startup forms whose entry/imports run after NODE_OPTIONS preloads.
  // Reject other modes: native tasks/snapshots, inspectors and require/loader
  // preloads can execute before this ESM guard. Node also accepts underscores.
  for (let index = 0; index < args.length; index++) {
    const arg = String(args[index]);
    if (arg === '--' || !arg.startsWith('-')) return true;
    const [flag, ...value] = arg.replaceAll('_', '-').split('=');
    if (['--import', '--eval', '--input-type', '-e'].includes(flag)) {
      if (!value.length && ++index >= args.length) return false;
    } else return false;
  }
  return true;
}
function guardedExec(file, env, shell = false, args = []) {
  const guarded = !shell && safeNodeArgs(args) && file === process.execPath
    && env.NODE_OPTIONS === process.env.NODE_OPTIONS
    && env.NODE_OPTIONS === `--import=${import.meta.url}`
    && env.KHALA_EGRESS_LOG === process.env.KHALA_EGRESS_LOG;
  record({ kind: 'exec', file: basename(String(file)), guarded, allowed: guarded });
  return guarded;
}
const spawnChild = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function (options) {
  const env = Object.fromEntries((options.envPairs ?? []).map(pair => {
    const separator = pair.indexOf('=');
    return [pair.slice(0, separator), pair.slice(separator + 1)];
  }));
  const duplicateGuardEnv = ['NODE_OPTIONS', 'KHALA_EGRESS_LOG'].some(key =>
    (options.envPairs ?? []).filter(pair => pair.startsWith(key + '=')).length !== 1);
  if (guardedExec(options.file, env, duplicateGuardEnv, (options.args ?? []).slice(1))) return spawnChild.call(this, options);
  const error = blocked('exec', basename(String(options.file)));
  const streams = [new PassThrough(), new PassThrough(), new PassThrough()];
  [this.stdin, this.stdout, this.stderr] = streams;
  this.stdio = streams;
  process.nextTick(() => {
    this._handle?.close();
    this._handle = null;
    for (const stream of streams) stream.destroy();
    this.emit('error', error);
    this.emit('close', -1, null);
  });
  return undefined;
};
for (const name of ['spawnSync', 'execFileSync', 'execSync']) {
  const original = childProcess[name];
  childProcess[name] = function (file, args, options) {
    const opts = (Array.isArray(args) || args == null ? options : args) ?? {};
    if (guardedExec(name === 'execSync' ? 'shell' : file, opts.env ?? process.env, name === 'execSync' || opts.shell, Array.isArray(args) ? args : [])) return original.apply(this, arguments);
    const error = blocked('exec', name === 'execSync' ? 'shell' : basename(String(file)));
    if (name !== 'spawnSync') throw error;
    return { error, pid: 0, status: null, signal: null, output: [null, null, null], stdout: null, stderr: null };
  };
}
module.syncBuiltinESMExports();
let seenMatrix = false;
if (module.registerHooks) module.registerHooks({ resolve(specifier, context, nextResolve) {
  const result = nextResolve(specifier, context);
  if (!seenMatrix && (specifier === 'matrix-js-sdk' || specifier.startsWith('matrix-js-sdk/') || result.url.includes('/matrix-js-sdk/'))) {
    seenMatrix = true;
    record({ kind: 'module', url: result.url });
  }
  return result;
} });
else record({ kind: 'guard', event: 'no_module_hooks' });
