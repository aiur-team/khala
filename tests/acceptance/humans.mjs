#!/usr/bin/env node
// KM-151 acceptance driver: acts as the two humans (A1, A2) by driving the
// operator's two already-running Firefox instances over WebDriver BiDi.
// Plain Node ESM, builtins only; the global WebSocket speaks BiDi directly.
//
// Invariants (docs/build/m1/tickets/KM-151.md):
//   I6: one BiDi session per Firefox at a time; every command ends its session.
//   I7: only tabs this driver created (recorded in run.json) are ever touched.
//   Never prints cookies, tokens or passwords.
//
// Elements are found by accessible name (aria-label, <label>, placeholder,
// visible text), roles and data-* attributes, never by CSS class, so design
// refreshes that keep names stable do not break the driver.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const COMMANDS = Object.freeze([
  'whoami', 'trust-local', 'reset-site', 'signin', 'setup', 'say', 'confirm', 'wait-for', 'transcript', 'cleanup',
]);
const PER_HUMAN = new Set(COMMANDS.filter(command => command !== 'setup'));
export const DEFAULT_PORTS = Object.freeze({ a1: 9222, a2: 9223 });
const HUMAN_INDEX = Object.freeze({ a1: 0, a2: 1 });

export class DriverError extends Error {
  constructor(code, step = 'driver') {
    super(code);
    this.code = code;
    this.step = step;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (covered by humans.test.mjs)

const FLAGS = new Map([
  ['--as', 'as'], ['--port', 'port'], ['--origin', 'origin'], ['--account', 'account'], ['--state-dir', 'stateDir'],
  ['--text', 'text'], ['--url', 'url'], ['--timeout', 'timeout'], ['--account-a1', 'accountA1'], ['--account-a2', 'accountA2'],
]);
const BOOLEAN_FLAGS = new Map([['--reload', 'reload']]);

/** Parses argv (without node and script) into a validated options object; throws DriverError on misuse. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || !COMMANDS.includes(command)) throw new DriverError('unknown_command', 'args');
  const options = { command, reload: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (BOOLEAN_FLAGS.has(flag)) { options[BOOLEAN_FLAGS.get(flag)] = true; continue; }
    if (!FLAGS.has(flag)) throw new DriverError('unknown_flag', 'args');
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) throw new DriverError('missing_value', 'args');
    options[FLAGS.get(flag)] = value;
    index += 1;
  }
  if (PER_HUMAN.has(command)) {
    if (options.as === undefined) throw new DriverError('missing_human', 'args');
    if (!Object.hasOwn(DEFAULT_PORTS, options.as)) throw new DriverError('invalid_human', 'args');
  } else if (options.as !== undefined) {
    throw new DriverError('unexpected_human', 'args');
  }
  if (options.port !== undefined) {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DriverError('invalid_port', 'args');
    options.port = port;
  } else if (options.as) {
    options.port = DEFAULT_PORTS[options.as];
  }
  if (options.timeout !== undefined) {
    const seconds = Number(options.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new DriverError('invalid_timeout', 'args');
    options.timeout = seconds;
  }
  if ((command === 'say' || command === 'wait-for') && !options.text) throw new DriverError('missing_text', 'args');
  if (command === 'confirm' && !options.url) throw new DriverError('missing_url', 'args');
  if (options.origin !== undefined) options.origin = normalizeOrigin(options.origin);
  options.stateDir = path.resolve(repoRoot, options.stateDir ?? '.khala-local/acceptance');
  return options;
}

export function normalizeOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new DriverError('invalid_origin', 'args'); }
  if (url.protocol !== 'https:') throw new DriverError('invalid_origin', 'args');
  return url.origin;
}

export function isLoopbackOrigin(origin) {
  const { hostname } = new URL(origin);
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

export function assertLoopback(origin, step) {
  if (!isLoopbackOrigin(origin)) throw new DriverError('not_loopback', step);
}

/** `--origin` wins; otherwise `stack:status` `.origin`. */
export function resolveOrigin(options, loadStatus) {
  if (options.origin) return options.origin;
  const status = loadStatus();
  if (!status || typeof status.origin !== 'string') throw new DriverError('stack_status_unavailable', 'origin');
  return normalizeOrigin(status.origin);
}

/** The Dex identity for a human: users[0] for a1, users[1] for a2. */
export function selectDexUser(status, as) {
  const user = status?.users?.[HUMAN_INDEX[as]];
  if (!user || typeof user.email !== 'string' || typeof user.password !== 'string') {
    throw new DriverError('dex_user_unavailable', 'signin');
  }
  return { email: user.email, password: user.password };
}

/**
 * Chooses the sign-in provider. A loopback origin uses the local Dex users;
 * any other origin uses the Google account chooser and must name --account.
 * `loadStatus` is only called for a loopback origin.
 */
export function planSignin({ origin, as, account }, loadStatus) {
  if (isLoopbackOrigin(origin)) return { provider: 'dex', user: selectDexUser(loadStatus(), as) };
  if (!account) throw new DriverError('missing_account', 'signin');
  return { provider: 'google', account };
}

/** Request/response matcher for the BiDi transport; independent of the socket. */
export function createBidiMatcher() {
  let nextId = 0;
  const pending = new Map();
  return {
    request(method, params = {}) {
      nextId += 1;
      const id = nextId;
      const message = JSON.stringify({ id, method, params });
      const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
      return { id, message, promise };
    },
    handle(raw) {
      let message;
      try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return false; }
      if (!message || typeof message.id !== 'number' || !pending.has(message.id)) return false;
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.type === 'error') {
        const error = new Error(message.message ?? message.error);
        error.code = message.error;
        error.method = entry.method;
        entry.reject(error);
      } else {
        entry.resolve(message.result);
      }
      return true;
    },
    rejectAll(error) {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    },
    get size() { return pending.size; },
  };
}

/** Pulls `roomId` out of the join page's "Channel: <roomId>" line. */
export function parseChannelLine(text) {
  const match = /Channel:\s*(\S+)/u.exec(text ?? '');
  return match ? match[1] : null;
}

export function emptyRunState(origin) {
  return { origin, channelLink: null, roomId: null, channelPath: null, tabs: { a1: [], a2: [] } };
}

// ---------------------------------------------------------------------------
// State and stack status

function runFile(stateDir) { return path.join(stateDir, 'run.json'); }

function readRunState(stateDir, origin) {
  try {
    const state = JSON.parse(readFileSync(runFile(stateDir), 'utf8'));
    if (origin && state.origin !== origin) return emptyRunState(origin);
    state.tabs ??= { a1: [], a2: [] };
    state.tabs.a1 ??= [];
    state.tabs.a2 ??= [];
    return state;
  } catch {
    return emptyRunState(origin);
  }
}

function writeRunState(stateDir, state) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = runFile(stateDir);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

let cachedStatus;
function loadStackStatus() {
  if (cachedStatus) return cachedStatus;
  try {
    const output = execFileSync(process.execPath, [path.join(repoRoot, 'infra/local/stack.mjs'), 'status'], {
      cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    cachedStatus = JSON.parse(output);
  } catch {
    throw new DriverError('stack_status_unavailable', 'stack-status');
  }
  return cachedStatus;
}

// ---------------------------------------------------------------------------
// BiDi transport

const SLEEP = ms => new Promise(resolve => setTimeout(resolve, ms));

// Exported for ad-hoc diagnostics; commands go through main().
export class Bidi {
  static async open(port) {
    const bidi = new Bidi(port);
    await bidi.connect();
    try {
      await bidi.send('session.new', { capabilities: {} }, 15_000);
    } catch (error) {
      bidi.ws.close();
      if (/maximum number of (active )?sessions/iu.test(error.message ?? '')) throw new DriverError('bidi_session_busy', 'session');
      throw new DriverError('bidi_session_failed', 'session');
    }
    bidi.sessionOpen = true;
    return bidi;
  }

  constructor(port) {
    this.port = port;
    this.matcher = createBidiMatcher();
    this.sessionOpen = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}/session`);
      this.ws = ws;
      ws.addEventListener('open', () => { settled = true; resolve(); });
      ws.addEventListener('error', () => { if (!settled) { settled = true; reject(new DriverError('bidi_unreachable', 'connect')); } });
      ws.addEventListener('message', event => { this.matcher.handle(String(event.data)); });
      ws.addEventListener('close', () => {
        this.matcher.rejectAll(new DriverError('bidi_closed', 'transport'));
        if (!settled) { settled = true; reject(new DriverError('bidi_unreachable', 'connect')); }
      });
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const { message, promise } = this.matcher.request(method, params);
    this.ws.send(message);
    if (!timeoutMs) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new DriverError('bidi_timeout', method);
        error.pendingPromise = promise;
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async close() {
    try {
      if (this.sessionOpen) await this.send('session.end', {}, 5_000);
    } catch { /* closing the socket also ends a BiDi-only session */ }
    this.sessionOpen = false;
    try { this.ws.close(); } catch { /* already closed */ }
  }

  async tree() {
    const { contexts } = await this.send('browsingContext.getTree', { maxDepth: 0 });
    return contexts;
  }

  async createTab() {
    const { context } = await this.send('browsingContext.create', { type: 'tab', background: true });
    return context;
  }

  async closeTab(context) {
    try { await this.send('browsingContext.close', { context }); } catch { /* already gone */ }
  }

  /** Navigates; a background tab that stalls for 30 s is activated once (Firefox throttles background timers). */
  async navigate(context, url, { tolerateErrorPage = false } = {}) {
    try {
      await this.send('browsingContext.navigate', { context, url, wait: 'complete' }, 30_000);
    } catch (error) {
      if (error instanceof DriverError && error.code === 'bidi_timeout' && error.pendingPromise) {
        await this.activate(context);
        await Promise.race([error.pendingPromise.catch(() => undefined), SLEEP(60_000)]);
        return;
      }
      if (tolerateErrorPage) return;
      // A redirect chain (sign-in) can abort the original navigation; the polling steps that follow decide.
      if (/error page|aborted|NS_BINDING_ABORTED/iu.test(error.message ?? '')) return;
      throw new DriverError('navigate_failed', 'navigate');
    }
  }

  async reload(context) {
    try {
      await this.send('browsingContext.reload', { context, wait: 'complete' }, 30_000);
    } catch (error) {
      if (error instanceof DriverError && error.code === 'bidi_timeout') { await this.activate(context); return; }
      throw new DriverError('reload_failed', 'reload');
    }
  }

  async activate(context) {
    try { await this.send('browsingContext.activate', { context }, 10_000); } catch { /* best effort */ }
  }

  /**
   * Runs `fn(H, arg)` in the page, where H is the in-page helper kit. Returns the
   * JSON-decoded result, or throws `{ code: 'script_failed' }` on an exception
   * or a navigation that tore down the realm.
   */
  async run(context, fn, arg = null) {
    const declaration = `async function (argJson) {
      const H = (${pageHelpers.toString()})();
      const value = await (${typeof fn === 'string' ? fn : fn.toString()})(H, JSON.parse(argJson));
      return JSON.stringify(value === undefined ? null : value);
    }`;
    let result;
    try {
      result = await this.send('script.callFunction', {
        functionDeclaration: declaration,
        arguments: [{ type: 'string', value: JSON.stringify(arg) }],
        target: { context }, awaitPromise: true, userActivation: true, resultOwnership: 'none',
      }, 30_000);
    } catch (error) {
      throw Object.assign(new Error(error.message), { code: 'script_failed' });
    }
    if (result.type !== 'success') {
      throw Object.assign(new Error(result.exceptionDetails?.text ?? 'exception'), { code: 'script_failed' });
    }
    return result.result?.type === 'string' ? JSON.parse(result.result.value) : null;
  }

  /** Polls `fn` every 250 ms until it returns a truthy value; tolerates navigations in flight. */
  async waitFor(context, fn, arg, { timeoutMs, step, code }) {
    const started = Date.now();
    let activated = false;
    for (;;) {
      try {
        const value = await this.run(context, fn, arg);
        if (value) return value;
      } catch { /* the page is navigating; poll again */ }
      const elapsed = Date.now() - started;
      if (elapsed > timeoutMs) throw new DriverError(code, step);
      if (!activated && elapsed > 30_000) { activated = true; await this.activate(context); }
      await SLEEP(250);
    }
  }
}

// In-page helper kit. Serialized into each script.callFunction; must stay self-contained.
function pageHelpers() {
  const norm = value => (value ?? '').replace(/\s+/gu, ' ').trim();
  const CANDIDATES = 'button, a, input, textarea, select, [role=button], [role=link]';
  const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  const names = el => {
    const result = [];
    const aria = el.getAttribute('aria-label');
    if (aria) result.push(norm(aria));
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) result.push(norm(labelledBy.split(/\s+/u).map(id => document.getElementById(id)?.textContent ?? '').join(' ')));
    for (const label of el.labels ?? []) result.push(norm(label.textContent));
    if (el.placeholder) result.push(norm(el.placeholder));
    if (el.title) result.push(norm(el.title));
    if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') result.push(norm(el.textContent));
    if (el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) result.push(norm(el.value));
    return result;
  };
  const findAll = (name, { exact = true } = {}) => [...document.querySelectorAll(CANDIDATES)]
    .filter(el => names(el).some(candidate => (exact ? candidate === name : candidate.includes(name))));
  // Prefers a rendered match; falls back to an unrendered one, because a narrow
  // window collapses the shell to one pane (the operator's windows vary in size).
  const find = (nameOrNames, options = {}) => {
    for (const pass of [false, true]) {
      for (const name of [].concat(nameOrNames)) {
        const all = findAll(name, options).filter(el => pass || visible(el));
        if (all.length) return options.last ? all[all.length - 1] : all[0];
      }
    }
    return null;
  };
  const enabled = el => !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const click = el => { el.scrollIntoView?.({ block: 'center' }); el.click(); return true; };
  const fill = (el, text) => {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  };
  const bodyText = () => norm(document.body?.innerText ?? document.body?.textContent ?? '');
  const hasText = text => bodyText().includes(text) || norm(document.body?.textContent).includes(text);
  const allText = () => norm(document.body?.textContent ?? '');
  const messageList = () => document.querySelector('ol[aria-label="Messages"], ul[aria-label="Messages"], [role=list][aria-label="Messages"]');
  // A timeline row is any list item in the "Messages" list that carries an event id.
  const rows = () => [...(messageList()?.querySelectorAll('li[data-event-id]') ?? [])];
  const isPending = li => li.hasAttribute('aria-live') || (li.getAttribute('data-event-id') ?? '').startsWith('txn_');
  // textContent, not innerText: immune to CSS text-transform and to panes a narrow window collapses.
  const textOf = node => norm(node?.textContent);
  // Thread row (KM-182): <li data-event-id> = [avatar (button or aria-hidden span)]? +
  // column <div> = [name <button aria-label="<label>, <ownership>, <time>">]? + bubble <div> + extras.
  // The name line shows only on the first row of a run and never on the viewer's
  // own rows (which also have no avatar), so later rows inherit from their run.
  const describeThreadRow = (li, previous) => {
    const children = [...li.children];
    const column = children.find(child => child.tagName === 'DIV');
    if (!column) return null;
    const hasAvatar = children.indexOf(column) > 0;
    const nameButton = [...column.children].find(child => child.tagName === 'BUTTON' && child.hasAttribute('aria-label'));
    const bubble = [...column.children].find(child => child.tagName === 'DIV');
    const pending = isPending(li);
    const text = textOf(bubble);
    if (nameButton) {
      const parts = nameButton.getAttribute('aria-label').split(', ');
      const ownership = parts.length >= 3 ? parts[parts.length - 2] : parts[1] ?? '';
      const kind = ownership.charAt(0).toUpperCase() + ownership.slice(1); // "Human", "Your agent", "Another person's agent"
      const label = norm(nameButton.querySelector('b')?.textContent) || parts.slice(0, Math.max(1, parts.length - 2)).join(', ');
      // Visible tags after the label: an id badge (#…), "Human", or an owner tag ("Kevin’s machine").
      const tags = [...nameButton.children].filter(child => child.tagName === 'SPAN').map(textOf);
      const badge = tags.find(tag => tag.startsWith('#'));
      const owner = tags.find(tag => !tag.startsWith('#') && tag !== 'Human') ?? null;
      return { sender: badge ? `${label} ${badge}` : label, kind, owner, text, pending };
    }
    if (!hasAvatar) return { sender: 'You', kind: 'You', owner: null, text, pending };
    if (previous) return { sender: previous.sender, kind: previous.kind, owner: previous.owner, text, pending };
    const avatarName = children[0].getAttribute('aria-label') ?? '';
    return { sender: avatarName.replace(/ details$/u, ''), kind: '', owner: null, text, pending };
  };
  // Earlier card markup: <header><strong>author</strong><span>kind</span><time/><span>status</span></header>.
  const describeLegacyRow = (li, header) => {
    const sender = textOf(header.querySelector('strong'));
    const spans = [...header.children].filter(child => child.tagName === 'SPAN').map(textOf);
    const pending = isPending(li);
    if (pending && spans.length) spans.pop(); // trailing send-state ("Sending…", "Sent")
    const bodyParts = [];
    for (let node = header.nextElementSibling; node; node = node.nextElementSibling) bodyParts.push(textOf(node));
    return { sender, kind: spans[0] || sender, owner: null, text: norm(bodyParts.join(' ')), pending };
  };
  // Events, pills and unavailable rows: no bubble column and no byline.
  const describeEventRow = li => {
    const titled = li.querySelector('[title^="From "]');
    const sender = titled ? titled.getAttribute('title').slice(5) : (/Changed by (.+)$/u.exec(textOf(li))?.[1] ?? '');
    const unavailable = /unavailable on this device/iu.test(li.textContent ?? '');
    return { sender, kind: unavailable ? 'unavailable' : 'event', owner: null, text: textOf(li), pending: false };
  };
  /** Every list item in "Messages" in order; rows without an event id (days, receipts) break runs. */
  const describeRows = () => {
    const out = [];
    let previous = null;
    for (const li of messageList()?.querySelectorAll(':scope > li') ?? []) {
      if (!li.hasAttribute('data-event-id')) { previous = null; continue; }
      const header = li.querySelector('header');
      const row = header ? describeLegacyRow(li, header) : describeThreadRow(li, previous) ?? describeEventRow(li);
      previous = row.kind === 'event' || row.kind === 'unavailable' ? null : row;
      out.push(row);
    }
    return out;
  };
  return { norm, find, findAll, enabled, click, fill, bodyText, allText, hasText, messageList, rows, isPending, describeRows };
}

// ---------------------------------------------------------------------------
// Browser steps

async function withBrowser(port, fn) {
  const bidi = await Bidi.open(port);
  try {
    return await fn(bidi);
  } finally {
    await bidi.close();
  }
}

// Tab identity. Firefox (152) issues new BiDi browsing-context ids in every
// session, so a context id cannot name a tab across commands. Each driver tab
// therefore carries a marker token in `window.name` and in the origin's
// `sessionStorage` (which survives a cross-site sign-in round trip); run.json
// records the tokens. Finding a tab only reads that marker, and only in tabs
// on the run origin or a Google sign-in page; nothing else is touched (I7).
const TAB_MARK_KEY = 'khalaAcceptanceTab';

export function newTabToken(as) {
  return `khala-acc-${as}-${randomUUID()}`;
}

export function isMarkerCandidate(url, origin) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin || parsed.hostname === 'accounts.google.com' || parsed.hostname === 'myaccount.google.com';
  } catch {
    return false;
  }
}

async function markTab(bidi, context, token) {
  await bidi.run(context, (H, mark) => {
    window.name = mark.token;
    try { sessionStorage.setItem(mark.key, mark.token); } catch { /* opaque origin */ }
    return true;
  }, { token, key: TAB_MARK_KEY }).catch(() => false);
}

/** token → current context id, for the given tokens that still exist. */
async function findDriverTabs(bidi, tokens, origin) {
  const wanted = new Set(tokens);
  const found = new Map();
  if (wanted.size === 0) return found;
  for (const info of await bidi.tree()) {
    if (!isMarkerCandidate(info.url, origin)) continue;
    const mark = await bidi.run(info.context, (H, key) => {
      if (window.name.startsWith('khala-acc-')) return window.name;
      try { return sessionStorage.getItem(key); } catch { return null; }
    }, TAB_MARK_KEY).catch(() => null);
    if (mark && wanted.has(mark) && !found.has(mark)) found.set(mark, info.context);
  }
  return found;
}

// Focus emulation. The app activates its encrypted device only in a tab that is
// visible and focused (document.visibilityState / document.hasFocus()), and a
// tab yields the device when another tab of the same owner claims it. The
// driver's tabs are background tabs in the operator's browser, so, like
// Playwright's focus emulation, the driver reports its own tabs as focused
// (only its own tabs: the preload script is scoped to their contexts). A tab
// can be "blurred" again so a second tab of the same human (confirm) can
// claim the device, then refocused afterwards.
// The same preload answers navigator.storage.persist() with `false`: in a real
// Firefox it opens a permission doorhanger that nobody answers in a background
// tab, and the app awaits it while getting its device ready. The app treats
// persistence as optional, and no Firefox permission or preference changes.
function installFocusEmulation(focused) {
  if (!window.__khalaFocusEmulation) {
    window.__khalaFocusEmulation = true;
    if (navigator.storage) {
      Object.defineProperty(navigator.storage, 'persist', { configurable: true, value: () => Promise.resolve(false) });
    }
    const realHasFocus = Document.prototype.hasFocus;
    Object.defineProperty(document, 'hasFocus', {
      configurable: true, value: () => window.__khalaDriverFocused === true || realHasFocus.call(document),
    });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: () => (window.__khalaDriverFocused === true ? 'visible' : 'hidden'),
    });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__khalaDriverFocused !== true });
  }
  const changed = window.__khalaDriverFocused !== focused;
  window.__khalaDriverFocused = focused;
  // A focus is always announced: it is how an inactive tab resumes ("Try again in this tab").
  if ((changed || focused) && document.readyState !== 'loading') {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event(focused ? 'focus' : 'blur'));
  }
  return true;
}

async function setTabFocus(bidi, context, focused) {
  // Future documents in this tab (reloads, navigations) during this command.
  try {
    await bidi.send('script.addPreloadScript', {
      functionDeclaration: `() => { (${installFocusEmulation.toString()})(${focused ? 'true' : 'false'}); }`,
      contexts: [context],
    });
  } catch { /* best effort; the live patch below still applies */ }
  // The current document.
  await bidi.run(context, `(H, focused) => (${installFocusEmulation.toString()})(focused)`, focused).catch(() => false);
}

/** Creates a background tab, opens `url` in it and marks it as this driver's. */
async function openDriverTab(bidi, url, token) {
  const context = await bidi.createTab();
  await setTabFocus(bidi, context, true);
  await bidi.navigate(context, url);
  await markTab(bidi, context, token);
  return context;
}

/** The human's run tab (tabs[as][0]); reopened at `fallbackUrl` if it no longer exists. */
async function runTab(bidi, state, as, fallbackUrl) {
  const token = state.tabs[as][0];
  if (token) {
    const context = (await findDriverTabs(bidi, [token], state.origin)).get(token);
    if (context) {
      await markTab(bidi, context, token);
      await setTabFocus(bidi, context, true);
      return context;
    }
  }
  const fresh = newTabToken(as);
  const context = await openDriverTab(bidi, fallbackUrl, fresh);
  state.tabs[as] = [fresh, ...state.tabs[as].filter(entry => entry !== token)];
  return context;
}

async function pageLocation(bidi, context) {
  return bidi.run(context, () => ({ href: location.href, origin: location.origin, pathname: location.pathname }));
}

// In-page: classifies where the sign-in flow currently stands.
function observeSignIn(H, appOrigin, dexPrefix, done) {
  const onApp = location.origin === appOrigin && !location.pathname.startsWith(dexPrefix) && !location.pathname.startsWith('/auth/');
  if (onApp && done(H)) return { state: 'done' };
  if (location.hostname === 'accounts.google.com') {
    const challenge = document.querySelector('input[type=password]')
      || /2-Step|verify it's you|browser or app may not be secure/iu.test(H.bodyText());
    return { state: challenge ? 'google_challenge' : 'google' };
  }
  const email = H.find(['Email', 'email address', 'Username']);
  const password = H.find('Password');
  if (email && password && email.tagName === 'INPUT') return { state: 'dex_form' };
  if (H.find(['Grant Access', 'Approve'])) return { state: 'dex_approve' };
  if (H.find(['Log in with Email', 'Log in with email'])) return { state: 'dex_connector' };
  if (onApp && H.find(['Sign in', 'Sign in to continue'])) return { state: 'sign_in_button' };
  return { state: 'waiting' };
}

/**
 * Drives the current tab to a signed-in app page on `origin`. Handles a signed-out
 * redirect to Dex or Google, the landing page's "Sign in" pill, and Dex's
 * optional approval screen. `isDone(H, origin)` decides when the app is ready.
 */
async function completeSignIn(bidi, context, { origin, plan, isDone, timeoutMs = 120_000 }) {
  const started = Date.now();
  const dexPrefix = '/dex';
  let lastAction = '';
  let lastState = '';
  while (Date.now() - started < timeoutMs) {
    let observed;
    try {
      // The done predicate is spliced into the source (no eval: the app's CSP may forbid it).
      observed = await bidi.run(context, `(H, { origin: appOrigin, dexPrefix: prefix }) => {
        const done = ${isDone.toString()};
        return (${observeSignIn.toString()})(H, appOrigin, prefix, done);
      }`, { origin, dexPrefix });
    } catch {
      await SLEEP(250);
      continue;
    }
    if (process.env.HUMANS_DEBUG === '1' && observed.state !== lastState) process.stderr.write(`signin: ${observed.state}\n`);
    lastState = observed.state;
    switch (observed.state) {
      case 'done':
        return;
      case 'google_challenge':
        throw new DriverError('google_challenge', 'signin');
      case 'dex_form':
        if (plan.provider !== 'dex') throw new DriverError('unexpected_dex', 'signin');
        if (lastAction === 'dex_form') await SLEEP(2_000); // a just-submitted form is still unloading
        await bidi.run(context, (H, user) => {
          const email = H.find(['Email', 'email address', 'Username']);
          const password = H.find('Password');
          H.fill(email, user.email);
          H.fill(password, user.password);
          const submit = H.find(['Login', 'Log in', 'Sign in']);
          if (submit) H.click(submit); else password.form?.requestSubmit();
          return true;
        }, plan.user).catch(() => undefined);
        lastAction = 'dex_form';
        await SLEEP(1_000);
        continue;
      case 'dex_approve':
        await bidi.run(context, H => H.click(H.find(['Grant Access', 'Approve']))).catch(() => undefined);
        await SLEEP(1_000);
        continue;
      case 'dex_connector':
        await bidi.run(context, H => H.click(H.find(['Log in with Email', 'Log in with email']))).catch(() => undefined);
        await SLEEP(1_000);
        continue;
      case 'sign_in_button':
        await bidi.run(context, H => H.click(H.find(['Sign in', 'Sign in to continue']))).catch(() => undefined);
        await SLEEP(1_000);
        continue;
      case 'google':
        if (plan.provider !== 'google') throw new DriverError('unexpected_google', 'signin');
        await bidi.run(context, (H, account) => {
          const choice = document.querySelector(`[data-identifier="${CSS.escape(account)}"], [data-email="${CSS.escape(account)}"]`);
          if (choice) { H.click(choice); return 'chose'; }
          const consent = H.find(['Continue', 'Allow']);
          if (consent) { H.click(consent); return 'consented'; }
          return null;
        }, plan.account).catch(() => undefined);
        await SLEEP(1_000);
        continue;
      default:
        await SLEEP(250);
    }
  }
  throw new DriverError('signin_timeout', 'signin');
}

// Signed in on /new with a ready device: the shell's "New channel" (+) button is
// enabled (it stays disabled while the device is getting ready). The earlier
// full-page form ("Channel name (optional)" + "Create channel") is also accepted.
const createScreenReady = H => H.enabled(H.find('New channel'))
  || (!!H.find('Create channel') && !!H.find('Channel name (optional)'));

async function signinInTab(bidi, context, { origin, plan }) {
  await bidi.navigate(context, `${origin}/new`);
  await completeSignIn(bidi, context, { origin, plan, isDone: createScreenReady });
}

function planFor(origin, as, account) {
  return planSignin({ origin, as, account }, loadStackStatus);
}

async function ensureOnChannel(bidi, context, state) {
  if (!state.channelPath) throw new DriverError('no_channel', 'run-state');
  const here = await pageLocation(bidi, context).catch(() => null);
  if (!here || here.origin !== state.origin || here.pathname !== state.channelPath) {
    await bidi.navigate(context, `${state.origin}${state.channelPath}`);
  }
  await bidi.waitFor(context, H => !!H.messageList() && !!H.find('Message'), null,
    { timeoutMs: 60_000, step: 'open-channel', code: 'channel_not_ready' });
}

// ---------------------------------------------------------------------------
// Commands

async function cmdWhoami(options) {
  await withBrowser(options.port, async bidi => {
    const context = await bidi.createTab();
    try {
      await bidi.navigate(context, 'https://myaccount.google.com/', { tolerateErrorPage: true });
      await SLEEP(2_500);
      const email = await bidi.run(context, H => /[A-Za-z0-9._%+-]+@gmail\.com/u.exec(H.bodyText())?.[0] ?? null).catch(() => null);
      process.stdout.write(`${email ?? 'none'}\n`);
    } finally {
      await bidi.closeTab(context);
    }
  });
}

async function cmdTrustLocal(options) {
  const origin = resolveOrigin(options, loadStackStatus);
  assertLoopback(origin, 'trust-local');
  await withBrowser(options.port, async bidi => {
    const context = await bidi.createTab();
    try {
      await bidi.navigate(context, `${origin}/`, { tolerateErrorPage: true });
      const page = await bidi.waitFor(context, () => ({ uri: document.documentURI, origin: location.origin }), null,
        { timeoutMs: 15_000, step: 'trust-local', code: 'trust_local_manual' });
      if (page.origin === origin && !page.uri.startsWith('about:')) {
        process.stdout.write(`trusted ${origin} (already)\n`);
        return;
      }
      if (!page.uri.startsWith('about:certerror')) throw new DriverError('trust_local_manual', 'trust-local');
      // Classic error page: #advancedButton / #exceptionDialogButton. Firefox 15x
      // (net-error-card, in a shadow root): #advanced-button / #exception-button.
      // The override button stays disabled until the window has OS focus (a
      // clickjacking delay); a background tab in a shared browser never gets it.
      // After a short grace period the driver lifts that delay on its own tab only.
      const clickDeep = (ids, force = false) => {
        const search = root => {
          for (const id of ids) {
            const found = root.getElementById?.(id);
            if (found) return found;
          }
          for (const el of root.querySelectorAll('*')) {
            if (!el.shadowRoot) continue;
            const found = search(el.shadowRoot);
            if (found) return found;
          }
          return null;
        };
        const button = search(document);
        if (!button) return false;
        if (force === 'probe') return true;
        if (force) {
          button.disabled = false;
          button.removeAttribute('disabled');
          if (force === 'click') button.click();
          return true;
        }
        if (button.disabled || button.hasAttribute('disabled')) return false;
        button.click();
        return true;
      };
      // Expand "Advanced" until the override button exists (the card renders
      // asynchronously, so an early click can be lost); never click it twice in a row.
      const exceptionIds = "['exceptionDialogButton', 'exception-button']";
      let expanded = false;
      for (let attempt = 0; attempt < 5 && !expanded; attempt += 1) {
        await SLEEP(1_000);
        expanded = await bidi.run(context, `(H) => {
          const clickDeep = ${clickDeep.toString()};
          if (clickDeep(${exceptionIds}, 'probe')) return true;
          clickDeep(['advancedButton', 'advanced-button']);
          return false;
        }`).catch(() => false);
      }
      if (!expanded) throw new DriverError('trust_local_manual', 'trust-local');
      const accepted = await bidi.waitFor(context, `(H) => (${clickDeep.toString()})(${exceptionIds})`,
        null, { timeoutMs: 3_000, step: 'trust-local', code: 'trust_local_manual' }).catch(() => false);
      if (!accepted) {
        // Enable, let the button re-render, then click, all in one realm visit. The click
        // navigates and may tear the realm down before it replies; the load check below decides.
        const forced = await bidi.run(context, `(H) => {
          const clickDeep = ${clickDeep.toString()};
          window.dispatchEvent(new FocusEvent('focus'));
          clickDeep(${exceptionIds}, true);
          return new Promise(resolve => setTimeout(() => resolve(clickDeep(${exceptionIds}, 'click')), 300));
        }`).catch(error => error.message);
        if (process.env.HUMANS_DEBUG === '1') process.stderr.write(`trust-local: forced override click -> ${forced}\n`);
      }
      await bidi.waitFor(context, (H, appOrigin) => location.origin === appOrigin && !document.documentURI.startsWith('about:'),
        origin, { timeoutMs: 30_000, step: 'trust-local', code: 'trust_local_manual' });
      process.stdout.write(`trusted ${origin}\n`);
    } finally {
      await bidi.closeTab(context);
    }
  });
}

async function cmdResetSite(options) {
  const origin = resolveOrigin(options, loadStackStatus);
  const state = readRunState(options.stateDir, origin);
  await withBrowser(options.port, async bidi => {
    // 1. Close this driver's own tabs (never anyone else's); a reset starts a new run.
    for (const context of (await findDriverTabs(bidi, state.tabs[options.as], origin)).values()) await bidi.closeTab(context);
    state.tabs[options.as] = [];
    writeRunState(options.stateDir, state);
    // 2. Cookies for the origin.
    try {
      await bidi.send('storage.deleteCookies', { partition: { type: 'storageKey', sourceOrigin: origin } });
    } catch {
      throw new DriverError('cookie_delete_failed', 'reset-site');
    }
    // 3. Site storage, from a fresh tab on the origin.
    const context = await bidi.createTab();
    try {
      await bidi.navigate(context, `${origin}/`);
      const result = await bidi.run(context, async () => {
        const outcome = { databases: 0, blocked: [], caches: 0, workers: 0 };
        const dbs = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
        await Promise.all(dbs.map(({ name }) => new Promise(resolve => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => { outcome.databases += 1; resolve(); };
          request.onerror = () => resolve();
          request.onblocked = () => { outcome.blocked.push(name); resolve(); };
        })));
        try { localStorage.clear(); } catch { /* unavailable */ }
        try { sessionStorage.clear(); } catch { /* unavailable */ }
        if (globalThis.caches) {
          for (const key of await caches.keys()) { await caches.delete(key); outcome.caches += 1; }
        }
        if (navigator.serviceWorker) {
          for (const registration of await navigator.serviceWorker.getRegistrations()) {
            await registration.unregister();
            outcome.workers += 1;
          }
        }
        return outcome;
      });
      if (!result) throw new DriverError('reset_failed', 'reset-site');
      if (result.blocked.length) throw new DriverError('reset_blocked', 'reset-site');
      process.stdout.write(`reset ${origin}: ${result.databases} databases, ${result.caches} caches, ${result.workers} service workers\n`);
    } catch (error) {
      if (error instanceof DriverError) throw error;
      throw new DriverError('reset_failed', 'reset-site');
    } finally {
      await bidi.closeTab(context);
    }
  });
}

async function cmdSignin(options) {
  const origin = resolveOrigin(options, loadStackStatus);
  const plan = planFor(origin, options.as, options.account);
  const state = readRunState(options.stateDir, origin);
  await withBrowser(options.port, async bidi => {
    const context = await runTab(bidi, state, options.as, `${origin}/new`);
    writeRunState(options.stateDir, state);
    await signinInTab(bidi, context, { origin, plan });
  });
  process.stdout.write(`signed in ${options.as} on ${origin}\n`);
}

async function cmdSetup(options) {
  const origin = resolveOrigin(options, loadStackStatus);
  const planA1 = planFor(origin, 'a1', options.accountA1 ?? options.account);
  const planA2 = planFor(origin, 'a2', options.accountA2);
  const previous = readRunState(options.stateDir, origin);
  const state = { ...emptyRunState(origin), tabs: previous.tabs };
  const channelName = `M1 acceptance ${new Date().toISOString().slice(0, 10)}`;

  // A1: sign in, create the channel, copy its link.
  await withBrowser(DEFAULT_PORTS.a1, async bidi => {
    const context = await runTab(bidi, state, 'a1', `${origin}/new`);
    writeRunState(options.stateDir, state);
    await signinInTab(bidi, context, { origin, plan: planA1 });
    // "New channel" (+) opens a popover with "Channel name" and "Create".
    await bidi.waitFor(context, (H, name) => {
      const field = H.find(['Channel name', 'Channel name (optional)']);
      if (!field) {
        const open = H.find('New channel');
        if (H.enabled(open) && open.getAttribute('aria-expanded') !== 'true') H.click(open);
        return false;
      }
      if (field.value !== name) H.fill(field, name);
      return true;
    }, channelName, { timeoutMs: 15_000, step: 'create-channel', code: 'create_form_missing' });
    await bidi.waitFor(context, H => {
      const button = H.find(['Create', 'Create channel'], { last: true });
      return H.enabled(button) ? H.click(button) : false;
    }, null, { timeoutMs: 15_000, step: 'create-channel', code: 'create_disabled' });
    const channelPath = await bidi.waitFor(context, () => (location.pathname.startsWith('/channels/') ? location.pathname : null), null,
      { timeoutMs: 60_000, step: 'create-channel', code: 'channel_not_created' });
    state.channelPath = channelPath;
    state.roomId = decodeURIComponent(channelPath.slice('/channels/'.length));
    // KM-183 header: "Invite" opens a popover whose "Copy link" copies the channel link.
    // Earlier shells exposed "Copy my channel link" directly; both are accepted.
    const link = await bidi.waitFor(context, async H => {
      let button = H.find(['Copy my channel link', 'Copy channel invite link', 'Copy link']);
      if (!button) {
        const invite = [...document.querySelectorAll('button[aria-label="Invite"][aria-expanded]')][0] ?? H.find('Invite');
        if (H.enabled(invite) && invite.getAttribute('aria-expanded') !== 'true') H.click(invite);
        return null;
      }
      if (!H.enabled(button)) return null;
      window.__khalaCopied = undefined;
      if (navigator.clipboard) navigator.clipboard.writeText = text => { window.__khalaCopied = text; return Promise.resolve(); };
      H.click(button);
      for (let index = 0; index < 40 && !window.__khalaCopied; index += 1) await new Promise(resolve => setTimeout(resolve, 250));
      return window.__khalaCopied ?? null;
    }, null, { timeoutMs: 60_000, step: 'copy-link', code: 'copy_link_failed' });
    if (!/\/join\/[^/?#]+$/u.test(link)) throw new DriverError('copy_link_invalid', 'copy-link');
    state.channelLink = link;
    writeRunState(options.stateDir, state);
  });

  // A2: sign in, open the link, open the channel.
  await withBrowser(DEFAULT_PORTS.a2, async bidi => {
    const context = await runTab(bidi, state, 'a2', `${origin}/new`);
    writeRunState(options.stateDir, state);
    await signinInTab(bidi, context, { origin, plan: planA2 });
    await bidi.navigate(context, state.channelLink);
    // The join result may sit in a collapsed pane (narrow window), so match on text content.
    const joined = await bidi.waitFor(context, H => {
      if (!H.hasText("You're in.")) return null;
      const line = [...document.querySelectorAll('p, div, span')].map(el => H.norm(el.textContent))
        .find(text => /^Channel:\s*\S+$/u.test(text));
      return { line: line ?? null };
    }, null, { timeoutMs: 120_000, step: 'join', code: 'join_failed' });
    const joinedRoom = parseChannelLine(joined.line);
    if (joinedRoom && joinedRoom !== state.roomId) throw new DriverError('join_room_mismatch', 'join');
    await bidi.run(context, H => H.click(H.find('Open channel')));
    await bidi.waitFor(context, (H, channelPath) => location.pathname === channelPath, state.channelPath,
      { timeoutMs: 60_000, step: 'open-channel', code: 'open_channel_failed' });
  });
  writeRunState(options.stateDir, state);
  process.stdout.write(`${state.channelLink}\n`);
}

async function cmdSay(options) {
  const state = readRunState(options.stateDir);
  if (!state.channelPath) throw new DriverError('no_channel', 'run-state');
  await withBrowser(options.port, async bidi => {
    const context = await runTab(bidi, state, options.as, `${state.origin}${state.channelPath}`);
    writeRunState(options.stateDir, state);
    await ensureOnChannel(bidi, context, state);
    await bidi.waitFor(context, (H, text) => {
      const input = H.find('Message');
      if (!input || input.disabled) return false;
      if (input.value !== text) H.fill(input, text);
      return true;
    }, options.text, { timeoutMs: 30_000, step: 'say', code: 'composer_unavailable' });
    await bidi.waitFor(context, H => {
      const send = H.find(['Send message', 'Send']);
      return H.enabled(send) ? H.click(send) : false;
    }, null, { timeoutMs: 30_000, step: 'say', code: 'send_disabled' });
    await bidi.waitFor(context, (H, text) => H.describeRows().some(row => !row.pending && row.text.includes(text)),
      options.text, { timeoutMs: 30_000, step: 'say', code: 'send_not_acknowledged' });
  });
  process.stdout.write(`sent as ${options.as}\n`);
}

async function cmdConfirm(options) {
  const state = readRunState(options.stateDir);
  const origin = state.origin ?? new URL(options.url).origin;
  await withBrowser(options.port, async bidi => {
    // Hand the human's device to the confirm tab: the run tab reports itself
    // unfocused so it yields when the new tab claims the device, and takes it
    // back afterwards (the app's one-active-tab-per-owner handoff).
    const runToken = state.tabs[options.as][0];
    const runContext = runToken ? (await findDriverTabs(bidi, [runToken], origin)).get(runToken) : undefined;
    if (runContext) await setTabFocus(bidi, runContext, false);
    // A NEW tab; it stays open afterwards because it performed the invite.
    const token = newTabToken(options.as);
    state.tabs[options.as].push(token);
    writeRunState(options.stateDir, state);
    const context = await openDriverTab(bidi, options.url, token);
    const ready = H => !!H.find('Confirm') || / joined .+\./u.test(H.bodyText());
    const plan = isLoopbackOrigin(origin) || options.account ? planFor(origin, options.as, options.account) : null;
    if (plan) await completeSignIn(bidi, context, { origin, plan, isDone: ready, timeoutMs: 120_000 });
    else await bidi.waitFor(context, ready, null, { timeoutMs: 120_000, step: 'confirm', code: 'confirm_not_shown' });
    await bidi.waitFor(context, H => {
      if (/ joined .+\./u.test(H.bodyText())) return true;
      const button = H.find('Confirm');
      return H.enabled(button) ? H.click(button) : false;
    }, null, { timeoutMs: 30_000, step: 'confirm', code: 'confirm_not_clickable' });
    const done = await bidi.waitFor(context, H => / joined .+\./u.exec(H.bodyText())?.[0] ?? null, null,
      { timeoutMs: 180_000, step: 'confirm', code: 'confirm_timeout' });
    if (runContext) {
      await setTabFocus(bidi, context, false);
      await setTabFocus(bidi, runContext, true);
      await bidi.waitFor(runContext, H => !!H.messageList() && H.enabled(H.find('Message')), null,
        { timeoutMs: 60_000, step: 'confirm', code: 'run_tab_not_resumed' });
    }
    process.stdout.write(`${done.trim()}\n`);
  });
}

async function cmdWaitFor(options) {
  const state = readRunState(options.stateDir);
  if (!state.channelPath) throw new DriverError('no_channel', 'run-state');
  await withBrowser(options.port, async bidi => {
    const context = await runTab(bidi, state, options.as, `${state.origin}${state.channelPath}`);
    writeRunState(options.stateDir, state);
    await ensureOnChannel(bidi, context, state);
    const row = await bidi.waitFor(context, (H, text) => {
      const match = H.describeRows().find(entry => entry.text.includes(text));
      return match ?? null;
    }, options.text, { timeoutMs: (options.timeout ?? 300) * 1_000, step: 'wait-for', code: 'wait_timeout' });
    process.stdout.write(`${JSON.stringify({ sender: row.sender, kind: row.kind, ...(row.owner ? { owner: row.owner } : {}), text: row.text })}\n`);
  });
}

async function cmdTranscript(options) {
  const state = readRunState(options.stateDir);
  if (!state.channelPath) throw new DriverError('no_channel', 'run-state');
  await withBrowser(options.port, async bidi => {
    const context = await runTab(bidi, state, options.as, `${state.origin}${state.channelPath}`);
    writeRunState(options.stateDir, state);
    await ensureOnChannel(bidi, context, state);
    if (options.reload) {
      await bidi.reload(context);
      await ensureOnChannel(bidi, context, state);
    }
    // Wait for history to settle: no loading status, then an unchanged row count for 3 s.
    let lastCount = -1;
    let stableSince = Date.now();
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const snapshot = await bidi.run(context, H => {
        const older = H.find('Load earlier messages');
        if (H.enabled(older)) { H.click(older); return { loading: true, count: -1 }; }
        const loading = [...document.querySelectorAll('[role=status]')].some(node => /Loading conversation|Checking agent names/u.test(node.textContent ?? ''));
        return { loading, count: H.rows().length, empty: H.hasText('No messages yet.') };
      }).catch(() => ({ loading: true, count: -1 }));
      if (snapshot.loading || snapshot.count !== lastCount) { lastCount = snapshot.count; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= 3_000) break;
      await SLEEP(250);
    }
    const rows = await bidi.run(context, H => H.describeRows());
    const transcript = (rows ?? []).filter(row => !row.pending)
      .map(({ sender, kind, owner, text }) => (owner ? { sender, kind, owner, text } : { sender, kind, text }));
    process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
  });
}

async function cmdCleanup(options) {
  const state = readRunState(options.stateDir);
  let closed = 0;
  await withBrowser(options.port, async bidi => {
    for (const context of (await findDriverTabs(bidi, state.tabs[options.as], state.origin)).values()) {
      await bidi.closeTab(context);
      closed += 1;
    }
  });
  state.tabs[options.as] = [];
  writeRunState(options.stateDir, state);
  process.stdout.write(`closed ${closed} tab(s) for ${options.as}\n`);
}

const HANDLERS = {
  whoami: cmdWhoami, 'trust-local': cmdTrustLocal, 'reset-site': cmdResetSite, signin: cmdSignin, setup: cmdSetup,
  say: cmdSay, confirm: cmdConfirm, 'wait-for': cmdWaitFor, transcript: cmdTranscript, cleanup: cmdCleanup,
};

export async function main(argv) {
  let command = argv[0] ?? '';
  try {
    const options = parseArgs(argv);
    command = options.command;
    await HANDLERS[options.command](options);
    return 0;
  } catch (error) {
    const code = error instanceof DriverError ? error.code : 'unexpected_error';
    const step = error instanceof DriverError ? error.step : command || 'driver';
    process.stderr.write(`humans.mjs ${command || '?'}: ${step} failed: ${code}\n`);
    if (process.env.HUMANS_DEBUG === '1') process.stderr.write(`${error.stack ?? error}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
