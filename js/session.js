// Game sessions.
//   Local:  the state lives in this tab.
//   Host:   the state lives in this tab and is sent to every player. The host's
//           browser is the server; PeerJS (WebRTC) connects players directly.
//   Client: sends actions to the host and shows whatever the host sends back.
import { apply, viewFor } from './engine.js';
import { validSeg } from './pad.js';

const PREFIX = 'aktivko-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_SEGS = 5000;
const CLIENT_ACTIONS = new Set([
  'team', 'choose', 'start', 'success', 'fail', 'next', 'guess',
  'settings', 'teamName', 'kick', 'begin', 'skip', 'end',
]);
const NETWORK_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']);

export function randomCode(len = 5) {
  const r = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(r, (x) => CODE_CHARS[x % CODE_CHARS.length]).join('');
}

export function randomId(len = 16) {
  const r = crypto.getRandomValues(new Uint32Array(len));
  return Array.from(r, (x) => (x % 36).toString(36)).join('');
}

export function cleanCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

export const peerAvailable = () => typeof window.Peer === 'function';

function cleanAction(a) {
  if (!a || typeof a !== 'object' || !CLIENT_ACTIONS.has(a.type)) return null;
  const out = { type: a.type };
  for (const k of ['team', 'difficulty']) if (Number.isInteger(a[k])) out[k] = a[k];
  for (const k of ['text', 'name', 'pid']) if (typeof a[k] === 'string') out[k] = a[k].slice(0, 80);
  if (a.settings && typeof a.settings === 'object') out.settings = a.settings;
  return out;
}

export class LocalSession {
  constructor(state, hooks) {
    this.kind = 'local';
    this.me = null;
    this.state = state;
    this.hooks = hooks;
    this.status = 'ready';
    this.iv = setInterval(() => this.dispatch({ type: 'tick' }), 250);
  }
  view() { return viewFor(this.state, null); }
  endsAt() { return this.state.phase === 'play' ? this.state.turn.endsAt : null; }
  dispatch(a) { if (apply(this.state, a, null, Date.now())) this.hooks.change(this.state); }
  sendSeg() {}
  clearPad() {}
  close() { clearInterval(this.iv); }
}

export class HostSession {
  constructor({ code, state, me, name, secrets, resume }, hooks) {
    this.kind = 'host';
    this.code = code;
    this.me = me;
    this.state = state;
    this.hooks = hooks;
    this.conns = new Map();
    this.secrets = { ...(secrets || {}) };
    this.banned = new Set();
    this.segs = [];
    this.status = 'connecting';
    this.resume = !!resume;
    this.everOpened = false;
    this.tries = 0;
    this.closed = false;

    state.mode = 'online';
    state.host = me;
    if (resume) for (const [pid, p] of Object.entries(state.players)) p.online = pid === me;
    apply(state, { type: 'join', name }, me);

    this.iv = setInterval(() => this.run({ type: 'tick' }, me), 250);
    if (!peerAvailable()) {
      this.status = 'unsupported';
      return;
    }
    this.open();
  }

  open() {
    if (this.closed) return;
    const peer = (this.peer = new window.Peer(PREFIX + this.code));
    peer.on('open', () => {
      if (peer !== this.peer) return;
      this.everOpened = true;
      this.tries = 0;
      this.status = 'ready';
      this.hooks.status();
    });
    peer.on('connection', (conn) => this.accept(conn));
    // Losing the signalling server only stops new players joining; players
    // already connected keep talking to us directly. Reconnect quietly.
    peer.on('disconnected', () => {
      setTimeout(() => {
        if (!this.closed && peer === this.peer && !peer.destroyed && peer.disconnected) peer.reconnect();
      }, 2000);
    });
    peer.on('error', (err) => this.onError(peer, err));
  }

  onError(peer, err) {
    if (this.closed || peer !== this.peer) return;
    if (err.type === 'unavailable-id') {
      peer.destroy();
      if (this.resume && ++this.tries <= 15) {
        // The server may still hold our old id for a few seconds after a reload.
        setTimeout(() => this.open(), 2000);
      } else if (!this.resume && !this.everOpened) {
        this.code = randomCode();
        this.open();
      } else {
        this.status = 'error';
        this.hooks.status();
      }
      return;
    }
    if (NETWORK_ERRORS.has(err.type)) {
      if (!this.everOpened) {
        peer.destroy();
        if (++this.tries > 5) {
          this.status = 'error';
          this.hooks.status();
          return;
        }
        setTimeout(() => this.open(), 2000);
      }
      return;
    }
    if (err.type === 'browser-incompatible') {
      this.status = 'unsupported';
      this.hooks.status();
    }
  }

  accept(conn) {
    conn.on('data', (m) => this.onData(conn, m));
    conn.on('close', () => this.drop(conn));
    conn.on('error', () => this.drop(conn));
  }

  onData(conn, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') return this.hello(conn, m);
    const pid = conn.pid;
    if (!pid || this.conns.get(pid) !== conn) return;
    if (m.t === 'act') {
      const a = cleanAction(m.a);
      if (a) this.run(a, pid);
    } else if (m.t === 'seg') {
      if (this.canDraw(pid) && validSeg(m.s)) this.addSeg(m.s, conn);
    } else if (m.t === 'clear') {
      if (this.canDraw(pid)) this.clearSegs(conn);
    }
  }

  hello(conn, { pid, secret, name }) {
    const refuse = (code) => {
      conn.send({ t: 'error', code });
      setTimeout(() => conn.close(), 500);
    };
    if (typeof pid !== 'string' || !/^[a-z0-9]{6,40}$/i.test(pid) || pid === this.me) return conn.close();
    if (typeof secret !== 'string' || secret.length < 8 || secret.length > 80) return conn.close();
    if (this.banned.has(pid)) return refuse('kicked');
    if (this.secrets[pid] && this.secrets[pid] !== secret) return refuse('taken');
    if (!apply(this.state, { type: 'join', name }, pid)) return refuse('full');
    this.secrets[pid] = secret;
    const old = this.conns.get(pid);
    if (old && old !== conn) {
      old.pid = null;
      old.close();
    }
    conn.pid = pid;
    this.conns.set(pid, conn);
    this.changed();
    conn.send({ t: 'segs', turnId: this.state.turnId, list: this.segs });
  }

  drop(conn) {
    const pid = conn.pid;
    if (!pid || this.conns.get(pid) !== conn) return;
    this.conns.delete(pid);
    conn.pid = null;
    if (apply(this.state, { type: 'leave' }, pid)) this.changed();
  }

  canDraw(pid) {
    const s = this.state;
    return s.phase === 'play' && s.turn.type === 'draw' && s.turn.performer === pid;
  }

  addSeg(seg, from) {
    if (this.segs.length >= MAX_SEGS) return;
    this.segs.push(seg);
    for (const conn of this.conns.values()) if (conn !== from && conn.open) conn.send({ t: 'seg', s: seg });
    if (from) this.hooks.seg(seg);
  }

  clearSegs(from) {
    this.segs = [];
    for (const conn of this.conns.values()) if (conn !== from && conn.open) conn.send({ t: 'clear' });
    if (from) this.hooks.clear();
  }

  run(a, pid) {
    const turnId = this.state.turnId;
    if (!apply(this.state, a, pid, Date.now())) return;
    if (a.type === 'kick') {
      this.banned.add(a.pid);
      delete this.secrets[a.pid];
      const conn = this.conns.get(a.pid);
      if (conn) {
        this.conns.delete(a.pid);
        conn.pid = null;
        conn.send({ t: 'kicked' });
        setTimeout(() => conn.close(), 500);
      }
    }
    if (this.state.turnId !== turnId) this.segs = [];
    this.changed();
  }

  changed() {
    const now = Date.now();
    for (const [pid, conn] of this.conns) if (conn.open) conn.send({ t: 'state', s: viewFor(this.state, pid, now) });
    this.hooks.change(this.state);
  }

  view() { return viewFor(this.state, this.me); }
  endsAt() { return this.state.phase === 'play' ? this.state.turn.endsAt : null; }
  dispatch(a) { this.run(a, this.me); }
  sendSeg(seg) { if (this.canDraw(this.me)) this.addSeg(seg, null); }
  clearPad() { if (this.canDraw(this.me)) this.clearSegs(null); }
  snapshot() { return { code: this.code, me: this.me, state: this.state, secrets: this.secrets }; }

  close() {
    this.closed = true;
    clearInterval(this.iv);
    this.peer?.destroy();
  }
}

export class ClientSession {
  constructor({ code, pid, secret, name }, hooks) {
    this.kind = 'client';
    this.code = code;
    this.me = pid;
    this.hello = { t: 'hello', pid, secret, name };
    this.hooks = hooks;
    this.state = null;
    this.ends = null;
    this.status = 'connecting';
    this.tries = 0;
    this.attempt = 0;
    this.closed = false;
    if (!peerAvailable()) {
      this.status = 'unsupported';
      return;
    }
    this.openPeer();
  }

  openPeer() {
    if (this.closed) return;
    if (this.peer && !this.peer.destroyed) this.peer.destroy();
    const peer = (this.peer = new window.Peer());
    peer.on('open', () => { if (peer === this.peer) this.connect(); });
    peer.on('error', (err) => { if (peer === this.peer) this.onError(err); });
  }

  connect() {
    if (this.closed) return;
    const id = ++this.attempt;
    const conn = this.peer.connect(PREFIX + this.code, { reliable: true });
    this.conn = conn;
    const timeout = setTimeout(() => {
      if (id === this.attempt && !conn.open) {
        conn.close();
        this.retry();
      }
    }, 10000);
    conn.on('open', () => {
      clearTimeout(timeout);
      if (id !== this.attempt) return conn.close();
      this.tries = 0;
      this.status = 'ready';
      conn.send(this.hello);
      this.hooks.status();
    });
    conn.on('data', (m) => { if (id === this.attempt) this.onData(m); });
    conn.on('close', () => {
      clearTimeout(timeout);
      if (id === this.attempt) this.retry();
    });
    conn.on('error', () => {});
  }

  retry() {
    if (this.closed) return;
    this.attempt++;
    this.tries++;
    if (!this.state && this.lastError === 'peer-unavailable' && this.tries >= 3) return this.stop('notfound');
    if (this.tries > 25) return this.stop('lost');
    this.status = this.state ? 'reconnecting' : 'connecting';
    this.hooks.status();
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.peer && this.peer.open && !this.peer.destroyed) this.connect();
      else this.openPeer();
    }, Math.min(1000 * this.tries, 5000));
  }

  onError(err) {
    this.lastError = err.type;
    if (err.type === 'browser-incompatible') return this.stop('unsupported');
    // A broken link to the signalling server doesn't affect an open data
    // channel to the host, so only retry when we're not connected.
    if (this.conn?.open && err.type !== 'peer-unavailable') return;
    this.retry();
  }

  stop(status) {
    this.status = status;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.peer?.destroy();
    this.hooks.status();
  }

  onData(m) {
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'state': {
        const s = m.s;
        this.state = s;
        this.ends = s.phase === 'play' && s.turn?.remaining != null ? Date.now() + s.turn.remaining : null;
        this.hooks.change(s);
        break;
      }
      case 'segs':
        this.hooks.segs(m.list, m.turnId);
        break;
      case 'seg':
        this.hooks.seg(m.s);
        break;
      case 'clear':
        this.hooks.clear();
        break;
      case 'kicked':
        this.stop('kicked');
        break;
      case 'error':
        this.stop(['taken', 'full', 'kicked'].includes(m.code) ? m.code : 'lost');
        break;
    }
  }

  view() { return this.state; }
  endsAt() { return this.state?.phase === 'play' ? this.ends : null; }
  dispatch(a) { if (this.conn?.open) this.conn.send({ t: 'act', a }); }
  sendSeg(seg) { if (this.conn?.open) this.conn.send({ t: 'seg', s: seg }); }
  clearPad() { if (this.conn?.open) this.conn.send({ t: 'clear' }); }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.peer?.destroy();
  }
}
