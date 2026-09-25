// UI: renders the current screen from the session's view of the game and turns
// clicks into game actions. Rendering is plain template strings; the drawing
// canvas is one long-lived element that gets moved into each new render.
import { TYPES, LENGTHS, TIMERS, MAX_TEAMS, DIFFICULTIES, TEAM_COLORS, defaultSettings, createState, apply, canStart, teamOf, cleanCustom } from './engine.js';
import { T, pluralIndex } from './i18n.js';
import { icon } from './icons.js';
import { Pad } from './pad.js';
import { LocalSession, HostSession, ClientSession, randomCode, randomId, cleanCode } from './session.js';

const REPO_URL = 'https://github.com/ShelbyAIdeals/activity-online';
const root = document.getElementById('app');

function makeStore(area) {
  const get = () => {
    try {
      return area();
    } catch {
      return null;
    }
  };
  return {
    get(k, d = null) {
      try {
        const v = get()?.getItem('aktivko.' + k);
        return v == null ? d : JSON.parse(v);
      } catch {
        return d;
      }
    },
    set(k, v) {
      try {
        get()?.setItem('aktivko.' + k, JSON.stringify(v));
      } catch {}
    },
    del(k) {
      try {
        get()?.removeItem('aktivko.' + k);
      } catch {}
    },
  };
}
// Saved games and settings survive closing the browser; who you are in an
// online room is per tab, so two tabs are two players.
const store = makeStore(() => localStorage);
const tab = makeStore(() => sessionStorage);

const app = {
  lang: store.get('lang') || (navigator.language?.toLowerCase().startsWith('sl') ? 'sl' : 'en'),
  screen: 'home',
  session: null,
  muted: store.get('muted', false),
  setup: null,
  ui: { reveal: false, peekUntil: 0, pickTeam: false, rules: false, toast: null, joinCode: '' },
  pad: new Pad(),
  padTurn: null,
  padEditable: false,
  lastPhase: null,
  lastSec: null,
  cols: 8,
};

function t(key, vars) {
  let s = T[app.lang]?.[key] ?? T.en[key] ?? key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
function plural(key, n) {
  const forms = t(key).split('|');
  return forms[Math.min(pluralIndex(app.lang, n), forms.length - 1)];
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const teamName = (i) => t('teamNames').split(',')[i] || `${t('team')} ${i + 1}`;
const splitWords = (text) => cleanCustom(String(text || '').split(/[\n,;]/));

function identity() {
  let id = tab.get('id');
  if (!id?.pid || !id?.secret) {
    id = { pid: 'p' + randomId(12), secret: randomId(24) };
    tab.set('id', id);
  }
  return id;
}

function usedFor(lang) {
  return store.get('used', {})[lang] || [];
}
function saveUsed(state) {
  const used = store.get('used', {});
  used[state.settings.lang] = state.used;
  store.set('used', used);
}

// ---------------------------------------------------------------- sound

let actx = null;
function unlockAudio() {
  try {
    actx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
  } catch {}
}
function tone(freq, dur, { type = 'sine', vol = 0.12, at = 0 } = {}) {
  if (app.muted || !actx) return;
  const t0 = actx.currentTime + at;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(actx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
}
const sfx = {
  tick: () => tone(880, 0.08, { vol: 0.07 }),
  buzz: () => {
    tone(196, 0.55, { type: 'sawtooth', vol: 0.07 });
    tone(185, 0.55, { type: 'sawtooth', vol: 0.05, at: 0.02 });
    if (!app.muted) navigator.vibrate?.(300);
  },
  win: () => [523, 659, 784].forEach((f, i) => tone(f, 0.18, { at: i * 0.1 })),
  miss: () => [392, 311].forEach((f, i) => tone(f, 0.22, { at: i * 0.15, vol: 0.08 })),
  fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i === 3 ? 0.6 : 0.16, { at: i * 0.13 })),
};

// ------------------------------------------------------------- wake lock

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {}
}

// -------------------------------------------------------------- sessions

const hooks = {
  change(state) {
    const s = app.session;
    if (!s) return;
    if (s.kind === 'local') {
      if (state.phase === 'over') store.del('local');
      else store.set('local', state);
      saveUsed(state);
    } else if (s.kind === 'host') {
      tab.set('host', { ...s.snapshot(), name: store.get('name', '') });
      saveUsed(state);
    }
    onViewChange();
  },
  status: () => render(),
  seg: (seg) => app.pad.add(seg),
  segs: (list) => app.pad.load(list),
  clear: () => app.pad.clear(),
};

app.pad.onSeg = (seg) => app.session?.sendSeg(seg);
app.pad.onClear = () => app.session?.clearPad();

function onViewChange() {
  const v = app.session?.view();
  if (!v) return render();
  if (v.turnId !== app.padTurn) {
    app.padTurn = v.turnId;
    app.pad.clear();
    app.ui.reveal = false;
    app.ui.pickTeam = false;
  }
  if (v.phase !== app.lastPhase) {
    if (v.phase === 'over' && app.lastPhase) {
      sfx.fanfare();
      confetti(v.teams[v.winner]?.color);
    } else if (v.phase === 'result' && app.lastPhase === 'play') {
      v.turn?.result?.success ? sfx.win() : sfx.miss();
    }
    app.lastPhase = v.phase;
  }
  render();
}

function startLocal(state) {
  app.session = new LocalSession(state, hooks);
  app.screen = 'play';
  app.padTurn = null;
  app.lastPhase = state.phase;
  onViewChange();
}

function newLocalGame() {
  const su = app.setup;
  store.set('setup', su);
  const players = {};
  let n = 0;
  const teams = su.teams.map((tm, i) => ({
    name: tm.name.trim().slice(0, 24) || teamName(i),
    players: tm.players
      .split(/[,;\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 12)
      .map((name) => {
        const pid = 'L' + ++n;
        players[pid] = { name: name.slice(0, 20), online: true };
        return pid;
      }),
  }));
  const settings = { ...su.settings, custom: splitWords(su.custom) };
  const state = createState({ mode: 'local', settings, teams, players, used: usedFor(settings.lang) });
  apply(state, { type: 'begin' });
  startLocal(state);
}

function startHost(saved) {
  const id = identity();
  const me = saved?.me || id.pid;
  const state =
    saved?.state ||
    createState({
      mode: 'online',
      settings: defaultSettings(app.lang),
      teams: [0, 1].map((i) => ({ name: teamName(i) })),
      host: me,
      used: usedFor(app.lang),
    });
  app.session = new HostSession(
    { code: saved?.code || randomCode(), state, me, name: saved?.name || store.get('name', ''), secrets: saved?.secrets, resume: !!saved },
    hooks,
  );
  app.screen = 'play';
  app.padTurn = null;
  app.lastPhase = state.phase;
  tab.set('host', { ...app.session.snapshot(), name: store.get('name', '') });
}

function startClient(code, name) {
  const id = identity();
  tab.set('client', { code, name });
  history.replaceState(null, '', `${location.pathname}?room=${code}`);
  app.session = new ClientSession({ code, pid: id.pid, secret: id.secret, name }, hooks);
  app.screen = 'play';
  app.padTurn = null;
  app.lastPhase = null;
}

function leave(force = false) {
  const s = app.session;
  if (s) {
    const live = !['notfound', 'lost', 'kicked', 'taken', 'full', 'error', 'unsupported'].includes(s.status);
    if (!force && s.kind !== 'local' && live && !confirm(t(s.kind === 'host' ? 'confirmCloseRoom' : 'confirmLeaveRoom'))) return;
    s.close();
    if (s.kind === 'host') tab.del('host');
    if (s.kind === 'client') tab.del('client');
  }
  app.session = null;
  app.screen = 'home';
  app.ui.pickTeam = false;
  app.ui.reveal = false;
  history.replaceState(null, '', location.pathname);
  render();
}

const roomLink = () => `${location.origin}${location.pathname}?room=${app.session.code}`;

function dispatch(a) {
  app.session?.dispatch(a);
}

function toast(msg) {
  app.ui.toast = msg;
  render();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    app.ui.toast = null;
    render();
  }, 1800);
}

function confetti(color) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = [color || '#e3a008', '#5b5bd6', '#0f9c8a', '#eb6a1f', '#e5484d'];
  const box = document.createElement('div');
  box.className = 'confetti';
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + '%';
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = Math.random() * 0.7 + 's';
    p.style.animationDuration = 2.2 + Math.random() * 1.6 + 's';
    p.style.setProperty('--x', Math.random() * 240 - 120 + 'px');
    p.style.setProperty('--r', Math.random() * 900 - 450 + 'deg');
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5000);
}

// ------------------------------------------------------------- rendering

function render() {
  const focus = captureFocus();
  document.documentElement.lang = app.lang;
  app.padEditable = false;
  const next = document.createElement('div');
  next.innerHTML =
    headerHTML() +
    `<main class="main">${screenHTML()}</main>` +
    (app.ui.rules ? rulesHTML() : '') +
    (app.ui.toast ? `<div class="toast" role="status">${esc(app.ui.toast)}</div>` : '');
  morphChildren(root, next);
  restoreFocus(focus);
  mountPad();
  fitBoard();
  updateTimer();
  keepAwake(app.screen === 'play' && !!app.session);
}

// Updates the live DOM in place to match freshly rendered HTML, so a focused
// input keeps focus (and the phone keyboard stays open) when someone else's
// guess arrives, and CSS transitions such as the score bars actually run.
function morphChildren(from, to) {
  const next = [...to.childNodes];
  next.forEach((nb, i) => {
    const na = from.childNodes[i];
    if (!na) from.appendChild(nb);
    else if (!sameNode(na, nb)) from.replaceChild(nb, na);
    else if (na.nodeType === 1) morphEl(na, nb);
    else if (na.nodeValue !== nb.nodeValue) na.nodeValue = nb.nodeValue;
  });
  while (from.childNodes.length > next.length) from.removeChild(from.lastChild);
}
function sameNode(a, b) {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName && (a.nodeType !== 1 || a.id === b.id);
}
function morphEl(a, b) {
  const keep = (name) => name === 'open' && a.tagName === 'DETAILS';
  for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value && !keep(name)) a.setAttribute(name, value);
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name) && !keep(name)) a.removeAttribute(name);
  if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') {
    if (a !== document.activeElement && a.value !== b.value) a.value = b.value;
    return;
  }
  if (a.id === 'pad-slot') return;
  morphChildren(a, b);
}

function captureFocus() {
  const el = document.activeElement;
  if (!el?.id || !('value' in el)) return null;
  return { id: el.id, value: el.value, start: el.selectionStart, end: el.selectionEnd };
}
function restoreFocus(f) {
  const el = f && document.getElementById(f.id);
  if (!el || el === document.activeElement) return;
  el.value = f.value;
  el.focus();
  try {
    el.setSelectionRange(f.start, f.end);
  } catch {}
}

function mountPad() {
  const slot = document.getElementById('pad-slot');
  if (!slot) return;
  slot.appendChild(app.pad.root);
  app.pad.setLabels({ color: t('color'), thin: t('thin'), thick: t('thick'), eraser: t('eraser'), clear: t('clear') });
  app.pad.setEditable(app.padEditable);
  app.pad.resize();
}

function fitBoard() {
  const board = document.querySelector('.board');
  if (!board) return;
  const cols = Math.max(7, Math.min(10, Math.floor((board.clientWidth + 5) / 46)));
  if (cols === app.cols) return;
  app.cols = cols;
  board.closest('.board-wrap').innerHTML = boardHTML(app.session.view());
}

function timeLeft() {
  const s = app.session;
  const total = (s?.state?.settings.timer || 60) * 1000;
  const ends = s?.endsAt() ?? null;
  const left = ends == null ? total : Math.max(0, ends - Date.now());
  return { ends, left, total, secs: Math.ceil(left / 1000) };
}

function updateTimer() {
  const box = document.getElementById('timer');
  if (!box || !app.session) {
    app.lastSec = null;
    return;
  }
  const { ends, left, total, secs } = timeLeft();
  box.querySelector('span').textContent = secs;
  box.querySelector('.prog').setAttribute('stroke-dashoffset', String(TIMER_C * (1 - left / total)));
  box.classList.toggle('low', secs <= 10);
  box.classList.toggle('done', secs === 0);
  if (ends != null && app.lastSec != null && secs < app.lastSec) {
    if (secs === 0) sfx.buzz();
    else if (secs <= 5) sfx.tick();
  }
  app.lastSec = ends == null ? null : secs;
}
const TIMER_C = 2 * Math.PI * 44;

function headerHTML() {
  return `<header class="top">
    <button class="brand" data-a="home" aria-label="Aktivko">${logo()}<span>Aktivko</span></button>
    <div class="top-actions">
      <div class="seg" role="group" aria-label="${t('language')}">
        ${['en', 'sl'].map((l) => `<button data-a="lang" data-v="${l}" aria-pressed="${app.lang === l}">${l.toUpperCase()}</button>`).join('')}
      </div>
      <button class="icon-btn" data-a="mute" aria-label="${t('sound')}" aria-pressed="${!app.muted}">${icon(app.muted ? 'soundOff' : 'soundOn')}</button>
      <button class="icon-btn" data-a="rules" aria-label="${t('rulesBtn')}">${icon('help')}</button>
    </div>
  </header>`;
}
const logo = () => '<span class="logo" aria-hidden="true"><i></i><i></i><i></i></span>';

function screenHTML() {
  switch (app.screen) {
    case 'setup':
      return setupHTML();
    case 'host':
      return hostFormHTML();
    case 'join':
      return joinFormHTML();
    case 'play':
      return app.session ? playHTML() : homeHTML();
    default:
      return homeHTML();
  }
}

function homeHTML() {
  const saved = store.get('local');
  const cont =
    saved?.teams && saved.phase !== 'over'
      ? `<button class="card continue" data-a="continue">
          <span><b>${t('continue')}</b><small>${esc(t('continueDesc', { teams: saved.teams.map((x) => x.name).join(' · '), round: saved.round }))}</small></span>
          ${icon('play')}
        </button>`
      : '';
  return `<section class="home">
    <div class="hero">
      <h1 class="title">Aktivko</h1>
      <p class="lede">${t('tagline')}</p>
      <div class="trio">${TYPES.map((k) => `<span class="chip type-${k}">${icon(k)}${t('type_' + k)}</span>`).join('')}</div>
    </div>
    <div class="modes">
      ${cont}
      <div class="card mode">
        <h2>${t('localTitle')}</h2>
        <p>${t('localDesc')}</p>
        <button class="btn primary big" data-a="go-setup">${t('localCta')}</button>
      </div>
      <div class="card mode">
        <h2>${t('onlineTitle')}</h2>
        <p>${t('onlineDesc')}</p>
        <button class="btn big" data-a="go-host">${t('hostCta')}</button>
        <form class="join-inline" data-form="join-code">
          <input id="home-code" name="code" maxlength="8" placeholder="${t('codePh')}" aria-label="${t('codePh')}" autocomplete="off" autocapitalize="characters" spellcheck="false">
          <button class="btn">${t('joinCta')}</button>
        </form>
      </div>
    </div>
    <p class="foot">${t('foot')} <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a></p>
  </section>`;
}

function optionsHTML(st, act) {
  const seg = (k, vals, label) => `<div class="opt"><span class="opt-label">${label}</span>
    <div class="seg" role="group" aria-label="${esc(label)}">${vals
      .map(([v, l]) => `<button type="button" data-a="${act}" data-k="${k}" data-v="${v}" aria-pressed="${String(st[k]) === String(v)}">${l}</button>`)
      .join('')}</div></div>`;
  return (
    (st.teams != null ? seg('teams', [2, 3, 4].map((n) => [n, n]), t('teamsCount')) : '') +
    seg('lang', [['en', 'English'], ['sl', 'Slovenščina']], t('deckLang')) +
    seg('length', Object.entries(LENGTHS).map(([k, n]) => [n, `${t('len_' + k)} ${n}`]), t('boardLength')) +
    seg('timer', TIMERS.map((n) => [n, n + ' s']), t('timer')) +
    seg('allPlay', [[true, t('on')], [false, t('off')]], `${t('allPlayFields')} <small class="hint">${t('allPlayHint')}</small>`)
  );
}

function parseOpt(k, v) {
  if (k === 'lang') return v;
  if (k === 'allPlay') return v === 'true';
  return Number(v);
}

function defaultSetup() {
  const saved = store.get('setup');
  if (saved?.teams?.length >= 2 && saved.settings) return saved;
  return { teams: [0, 1].map((i) => ({ name: teamName(i), players: '' })), settings: defaultSettings(app.lang), custom: '' };
}

function setupHTML() {
  const su = app.setup;
  return `<section class="card narrow setup">
    <button class="link back" data-a="home">← ${t('back')}</button>
    <h2>${t('setupTitle')}</h2>
    <div class="team-list">
      ${su.teams
        .map(
          (tm, i) => `<div class="team-edit" style="--team:${TEAM_COLORS[i]}">
        <span class="swatch"></span>
        <div class="fields">
          <input id="tn-${i}" data-in="team-name" data-i="${i}" value="${esc(tm.name)}" maxlength="24" placeholder="${t('teamNamePh')}" aria-label="${t('teamNamePh')}">
          <input id="tp-${i}" data-in="team-players" data-i="${i}" value="${esc(tm.players)}" placeholder="${t('playersPh')}" aria-label="${t('playersPh')}">
        </div>
        ${su.teams.length > 2 ? `<button class="icon-btn" data-a="team-remove" data-i="${i}" aria-label="${t('removeTeam')}">${icon('x')}</button>` : '<span></span>'}
      </div>`,
        )
        .join('')}
    </div>
    ${su.teams.length < MAX_TEAMS ? `<button class="btn ghost small add" data-a="team-add">${icon('plus')} ${t('addTeam')}</button>` : ''}
    <h3>${t('options')}</h3>
    ${optionsHTML(su.settings, 'setup-opt')}
    <details class="custom" ${su.custom ? 'open' : ''}>
      <summary>${t('customWords')}</summary>
      <textarea id="custom" data-in="custom" rows="4" placeholder="${t('customPh')}">${esc(su.custom)}</textarea>
      <p class="hint">${t('customHint')}</p>
    </details>
    <button class="btn primary big" data-a="setup-start">${icon('play')} ${t('startGame')}</button>
  </section>`;
}


function hostFormHTML() {
  return `<section class="card narrow">
    <button class="link back" data-a="home">← ${t('back')}</button>
    <h2>${t('hostTitle')}</h2>
    <p class="muted">${t('hostDesc')}</p>
    <form data-form="host" class="stack">
      <label>${t('yourName')}<input id="host-name" name="name" required maxlength="20" autocomplete="nickname" value="${esc(store.get('name', ''))}"></label>
      <button class="btn primary big">${t('createRoom')}</button>
    </form>
  </section>`;
}

function joinFormHTML() {
  return `<section class="card narrow">
    <button class="link back" data-a="home">← ${t('back')}</button>
    <h2>${t('joinTitle')}</h2>
    <form data-form="join" class="stack">
      <label>${t('roomCode')}<input id="join-code" name="code" required maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" class="code-input" value="${esc(app.ui.joinCode)}"></label>
      <label>${t('yourName')}<input id="join-name" name="name" required maxlength="20" autocomplete="nickname" value="${esc(store.get('name', ''))}"></label>
      <button class="btn primary big">${t('joinCta')}</button>
    </form>
  </section>`;
}

function statusHTML(s) {
  const box = (body, actions = '') => `<section class="card narrow center">${body}<div class="row">${actions}</div></section>`;
  const home = `<button class="btn" data-a="home-force">${t('backHome')}</button>`;
  switch (s.status) {
    case 'connecting':
      if (s.kind === 'client' && s.state) return '';
      return box(`<div class="spinner"></div><p>${s.kind === 'host' ? t('creating') : esc(t('connecting', { code: s.code }))}</p>`, home);
    case 'notfound':
      return box(`<p>${esc(t('notFound', { code: s.code }))}</p>`, `<button class="btn primary" data-a="retry">${t('tryAgain')}</button>${home}`);
    case 'lost':
      return box(`<p>${t('lost')}</p>`, `<button class="btn primary" data-a="retry">${t('tryAgain')}</button>${home}`);
    case 'kicked':
    case 'taken':
    case 'full':
    case 'unsupported':
      return box(`<p>${t(s.status)}</p>`, home);
    case 'error':
      return box(`<p>${t('hostError')}</p>`, home);
  }
  return '';
}

function playHTML() {
  const s = app.session;
  if (s.kind !== 'local') {
    const blocked = statusHTML(s);
    if (blocked) return blocked;
  }
  const v = s.view();
  if (!v) return statusHTML({ ...s, status: 'connecting' });
  const banner = s.status === 'reconnecting' ? `<div class="banner" role="status">${t('reconnecting')}</div>` : '';
  return banner + (v.phase === 'lobby' ? lobbyHTML(v) : gameHTML(v));
}

// ---------------------------------------------------------------- lobby

function lobbyHTML(v) {
  const me = app.session.me;
  const isHost = me === v.host;
  const myTeam = teamOf(v, me);
  const ready = canStart(v);
  return `<section class="lobby">
    <div class="card room">
      <p class="eyebrow">${t('roomCode')}</p>
      <div class="code">${esc(app.session.code)}</div>
      <p class="muted">${t('shareHint')}</p>
      <div class="row">
        <button class="btn" data-a="copy-link">${icon('copy')} ${t('copyLink')}</button>
        ${navigator.share ? `<button class="btn" data-a="share">${icon('share')} ${t('share')}</button>` : ''}
      </div>
    </div>
    <div class="teams-grid">
      ${v.teams
        .map(
          (tm, i) => `<div class="card team-col" style="--team:${tm.color}">
        ${
          isHost
            ? `<input id="otn-${i}" class="team-title-input" data-ch="team-name" data-i="${i}" value="${esc(tm.name)}" maxlength="24" aria-label="${t('teamNamePh')}">`
            : `<h3>${esc(tm.name)}</h3>`
        }
        <ul>
          ${
            tm.players.length
              ? tm.players
                  .map((pid) => {
                    const p = v.players[pid];
                    return `<li class="${p?.online ? '' : 'off'}"><span class="online-dot"></span><span class="pname">${esc(p?.name)}</span>
                ${pid === me ? `<span class="tag">${t('you')}</span>` : ''}
                ${pid === v.host ? `<span class="tag host">${icon('crown')}${t('host')}</span>` : ''}
                ${isHost && pid !== me ? `<button class="icon-btn small" data-a="kick" data-pid="${esc(pid)}" data-name="${esc(p?.name)}" aria-label="${esc(t('kick', { name: p?.name }))}">${icon('x')}</button>` : ''}</li>`;
                  })
                  .join('')
              : `<li class="muted">${t('empty')}</li>`
          }
        </ul>
        ${myTeam === i ? '' : `<button class="btn small" data-a="team" data-i="${i}">${t('joinTeam')}</button>`}
      </div>`,
        )
        .join('')}
    </div>
    <div class="card">
      <h3>${t('options')}</h3>
      ${
        isHost
          ? optionsHTML({ ...v.settings, teams: v.teams.length }, 'opt') +
            `<details class="custom" ${v.settings.custom.length ? 'open' : ''}>
              <summary>${t('customWords')}</summary>
              <textarea id="ocustom" data-ch="custom" rows="4" placeholder="${t('customPh')}">${esc(v.settings.custom.join('\n'))}</textarea>
              <p class="hint">${t('customHint')}</p>
            </details>`
          : `<ul class="summary">
              <li>${t('deckLang')}: <b>${v.settings.lang === 'sl' ? 'Slovenščina' : 'English'}</b></li>
              <li>${t('boardLength')}: <b>${v.settings.length}</b></li>
              <li>${t('timer')}: <b>${v.settings.timer} s</b></li>
              <li>${t('allPlayFields')}: <b>${v.settings.allPlay ? t('on') : t('off')}</b></li>
              ${v.settings.customCount ? `<li>${t('customCount', { n: v.settings.customCount })}</li>` : ''}
            </ul>`
      }
    </div>
    ${
      isHost
        ? `<button class="btn primary big" data-a="begin" ${ready ? '' : 'disabled'}>${icon('play')} ${t('startGame')}</button>
           ${ready ? '' : `<p class="hint center-text">${t('needPlayers')}</p>`}`
        : `<p class="wait center-text">${t('waitHost')}</p>`
    }
  </section>`;
}

// ----------------------------------------------------------------- game

function gameHTML(v) {
  return `<section class="game">
    <div class="panel">
      ${scoreHTML(v)}
      <div class="card turn" style="--team:${v.teams[v.phase === 'over' ? v.winner : (v.turn?.team ?? 0)].color}">${v.phase === 'over' ? overHTML(v) : turnHTML(v)}</div>
      ${toolsHTML(v)}
    </div>
    <div class="card board-wrap">${boardHTML(v)}</div>
  </section>`;
}

function scoreHTML(v) {
  const online = v.mode !== 'local';
  return `<div class="card score">${v.teams
    .map(
      (tm, i) => `<div class="score-row${v.phase !== 'over' && i === v.current ? ' active' : ''}" style="--team:${tm.color}">
      <span class="dot"></span>
      <span class="name">${esc(tm.name)}</span>
      <span class="bar"><i style="width:${Math.round((tm.pos / v.settings.length) * 100)}%"></i></span>
      <span class="pos">${tm.pos}<small>/${v.settings.length}</small></span>
      ${online || tm.players.length ? `<span class="members">${tm.players.map((p) => esc(v.players[p]?.name)).join(', ')}</span>` : ''}
    </div>`,
    )
    .join('')}</div>`;
}

function fieldHTML(tt) {
  return `<div class="field-card type-${tt.type}">
    <div class="field-icon">${icon(tt.type)}</div>
    <div class="field-text">
      <div class="field-type">${t('do_' + tt.type)}</div>
      <div class="field-rule">${t('rule_' + tt.type)}</div>
    </div>
  </div>
  ${tt.all ? `<div class="allplay">${icon('star')} ${t('allPlay')}</div>` : ''}`;
}

function headHTML(v) {
  const team = v.teams[v.turn.team];
  return `<div class="turn-head">
    <div class="turn-team"><span class="dot"></span>${esc(team.name)}</div>
    <div class="muted">${t('round', { n: v.round })}</div>
  </div>`;
}

function turnHTML(v) {
  const tt = v.turn;
  const local = v.mode === 'local';
  const me = app.session.me;
  const team = v.teams[tt.team];
  const perfName = tt.performer ? v.players[tt.performer]?.name : null;
  const iPerform = local || me === tt.performer;
  const myTeam = local ? -1 : teamOf(v, me);
  const canGuess = !local && !iPerform && myTeam >= 0 && (tt.all || myTeam === tt.team);
  const who = esc(perfName || team.name);

  if (v.phase === 'choose') {
    const lead = local
      ? `<p class="pass">${perfName ? t('passTo', { name: esc(perfName) }) : t('passToTeam', { team: esc(team.name) })}</p>`
      : `<p class="pass">${iPerform ? `<b>${t('youPerform')}</b>` : t('performs', { name: who })}</p>`;
    const pick = iPerform
      ? `<p class="label">${t('chooseDiff')}</p>
         <div class="diff">${DIFFICULTIES.map(
           (d) => `<button class="diff-btn" data-a="choose" data-d="${d}"><b>${d}</b><span>${t('diff' + d)}</span></button>`,
         ).join('')}</div>`
      : `<p class="wait">${t('choosing', { name: who })}</p>`;
    return headHTML(v) + fieldHTML(tt) + lead + pick;
  }

  if (v.phase === 'ready') {
    const start = `<button class="btn primary big" data-a="start">${icon('play')} ${t('startTimer', { s: v.settings.timer })}</button>`;
    let body;
    if (!iPerform) body = `<p class="wait">${t('readingWord', { name: who })}</p>`;
    else if (local && !app.ui.reveal)
      body = `<button class="word-card covered" data-a="reveal">${icon('eye')}<span class="big-label">${t('tapReveal')}</span>
        <small>${perfName ? esc(t('onlyName', { name: perfName })) : t('onlyPerformer')}</small></button>${start}`;
    else body = wordCardHTML(tt, local) + start;
    return headHTML(v) + fieldHTML(tt) + body;
  }

  if (v.phase === 'play') {
    const peeking = app.ui.peekUntil > Date.now();
    let top = timerHTML();
    if (iPerform && !local) top += `<div class="word-strip"><span>${t('yourWord')}</span><b>${esc(tt.word)}</b></div>`;
    else if (local) top += `<button class="btn peek" data-a="peek">${peeking ? `<b>${esc(tt.word)}</b>` : `${icon('eye')} ${t('peek')}`}</button>`;
    else top += `<div class="play-who">${t('performs', { name: who })}</div>`;

    let middle;
    if (tt.type === 'draw') {
      app.padEditable = iPerform;
      middle = '<div id="pad-slot" class="pad-slot"></div>';
    } else {
      const text = iPerform || local ? t('rule_' + tt.type) : canGuess ? t('watch_' + tt.type) : '';
      middle = `<div class="act-hint type-${tt.type}">${icon(tt.type)}<b>${t('do_' + tt.type)}</b>${text ? `<p>${text}</p>` : ''}</div>`;
    }

    let guessBox = '';
    if (canGuess) {
      guessBox = `<form class="guess" data-form="guess">
        <input id="guess" name="guess" maxlength="60" autocomplete="off" placeholder="${t('guessPh')}" aria-label="${t('guessPh')}" enterkeyhint="send">
        <button class="btn primary" aria-label="${t('send')}">${icon('send')}</button>
      </form>`;
    } else if (!local && !iPerform) {
      guessBox = `<p class="hint">${t('onlyTeam', { team: esc(team.name) })}</p>`;
    }
    const feed = !local && v.guesses.length ? feedHTML(v) : '';

    let controls = '';
    if (iPerform) {
      controls =
        tt.all && app.ui.pickTeam
          ? `<div class="pick"><p class="label">${t('whoGuessed')}</p>
              ${v.teams.map((x, i) => `<button class="btn pick-team" data-a="success" data-team="${i}" style="--team:${x.color}"><span class="dot"></span>${esc(x.name)}</button>`).join('')}
              <button class="btn ghost" data-a="pick-cancel">${t('cancel')}</button></div>`
          : `<div class="controls">
              <button class="btn ok big" data-a="success">${icon('check')} ${t('guessed')}</button>
              <button class="btn bad big" data-a="fail">${icon('x')} ${t('notGuessed')}</button>
            </div>`;
    }
    const timeUp = tt.timeUp ? `<p class="timeup">${iPerform ? t('timeUp') : t('timeUpWatch')}</p>` : '';
    const allChip = tt.all ? `<div class="allplay">${icon('star')} ${t('allPlay')}</div>` : '';
    return `${headHTML(v)}${allChip}<div class="play-top">${top}</div>${middle}${timeUp}${guessBox}${feed}${controls}`;
  }

  if (v.phase === 'result') {
    const r = tt.result;
    const next = v.teams[(v.current + 1) % v.teams.length];
    const n = r.success ? r.to - r.from : 0;
    return `${headHTML(v)}
      <div class="result ${r.success ? 'ok' : 'miss'}">
        <div class="result-icon">${icon(r.success ? 'check' : 'x')}</div>
        <h3>${r.success ? t('gotIt') : r.skipped ? t('skipped') : t('missed')}</h3>
        ${tt.word ? `<p>${t('wordWas')} <b class="result-word">${esc(tt.word)}</b></p>` : ''}
        ${r.success ? `<p>${t('moved', { team: esc(v.teams[r.team].name), n, fields: plural('fields', n) })}</p>` : ''}
        ${r.by ? `<p class="muted">${t('guessedBy', { name: esc(v.players[r.by]?.name) })}</p>` : ''}
      </div>
      ${feedHTML(v)}
      <button class="btn primary big" data-a="next">${t('nextTurn', { team: esc(next.name) })}</button>`;
  }
  return '';
}

function wordCardHTML(tt, local) {
  return `<div class="word-card">
    <span class="eyebrow">${t('yourWord')} · ${t('diff' + tt.difficulty)} ${tt.difficulty}</span>
    <div class="word">${esc(tt.word)}</div>
    ${local ? `<button class="link" data-a="reveal">${t('hide')}</button>` : ''}
  </div>`;
}

function timerHTML() {
  const { left, total, secs } = timeLeft();
  const cls = secs === 0 ? ' low done' : secs <= 10 ? ' low' : '';
  return `<div class="timer${cls}" id="timer" role="timer">
    <svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="44"/><circle class="prog" cx="50" cy="50" r="44" stroke-dasharray="${TIMER_C}" stroke-dashoffset="${TIMER_C * (1 - left / total)}"/></svg>
    <span>${secs}</span>
  </div>`;
}

function feedHTML(v) {
  if (!v.guesses?.length) return '';
  return `<ul class="feed" aria-live="polite">${v.guesses
    .slice(-6)
    .reverse()
    .map((g) => `<li class="${g.ok ? 'ok' : ''}"><b>${esc(v.players[g.pid]?.name || '?')}</b>${esc(g.text)}</li>`)
    .join('')}</ul>`;
}

function overHTML(v) {
  const w = v.teams[v.winner];
  const isHost = v.mode === 'local' || app.session.me === v.host;
  return `<div class="over" style="--team:${w.color}">
    <div class="trophy">${icon('trophy')}</div>
    <h2>${t('wins', { team: esc(w.name) })}</h2>
    ${v.turn?.word ? `<p>${t('lastWord')} <b>${esc(v.turn.word)}</b></p>` : ''}
    <p class="muted">${t('rounds', { n: v.round })}</p>
    <div class="stack">
      ${isHost ? `<button class="btn primary big" data-a="again">${t('playAgain')}</button>` : `<p class="wait">${t('waitHost')}</p>`}
      ${v.mode !== 'local' && isHost ? `<button class="btn" data-a="to-lobby">${t('backLobby')}</button>` : ''}
      <button class="btn ghost" data-a="home">${v.mode === 'local' ? t('backHome') : t('leaveRoom')}</button>
    </div>
  </div>`;
}

function toolsHTML(v) {
  if (v.phase === 'over') return '';
  const local = v.mode === 'local';
  const isHost = local || app.session.me === v.host;
  const skip = isHost && v.phase !== 'result' ? `<button class="btn ghost small" data-a="skip">${icon('skip')} ${t('skipTurn')}</button>` : '';
  const end = local
    ? `<button class="btn ghost small" data-a="home">${t('quit')}</button>`
    : isHost
      ? `<button class="btn ghost small" data-a="end">${t('endGame')}</button>`
      : `<button class="btn ghost small" data-a="home">${t('leaveRoom')}</button>`;
  return `<div class="tools">${skip}${end}</div>`;
}

function boardHTML(v) {
  const n = v.settings.length;
  const cols = app.cols;
  const active = v.turn && ['choose', 'ready', 'play'].includes(v.phase) ? v.teams[v.turn.team].pos : -1;
  let cells = '';
  for (let i = 0; i <= n; i++) {
    const row = Math.floor(i / cols);
    const c = i % cols;
    const col = row % 2 ? cols - 1 - c : c;
    const f = i < n ? v.board[i] : null;
    const here = v.teams.map((tm, k) => (tm.pos === i ? k : -1)).filter((k) => k >= 0);
    const cls = ['cell', f ? 'type-' + f.type : 'finish', f?.all ? 'all' : '', i === 0 ? 'start' : '', here.length ? 'occupied' : '', i === active ? 'current' : '']
      .filter(Boolean)
      .join(' ');
    const label = f ? `${i}: ${t('type_' + f.type)}${f.all ? ', ' + t('allPlay') : ''}` : t('finish');
    cells += `<div class="${cls}" style="grid-row:${row + 1};grid-column:${col + 1}${i === active ? `;--team:${v.teams[v.turn.team].color}` : ''}" title="${esc(label)}">
      ${icon(f ? f.type : 'flag')}
      ${i === 0 ? `<span class="cell-tag">${t('start')}</span>` : ''}
      ${i > 0 && i < n && i % 5 === 0 ? `<span class="num">${i}</span>` : ''}
      ${f?.all ? `<span class="star">${icon('star')}</span>` : ''}
      ${here.length ? `<span class="tokens n${here.length}">${here.map((k) => `<i style="--team:${v.teams[k].color}"></i>`).join('')}</span>` : ''}
    </div>`;
  }
  return `<div class="board" style="--cols:${cols}">${cells}</div>
    <div class="legend">
      ${TYPES.map((k) => `<span class="type-${k}"><i></i>${t('type_' + k)}</span>`).join('')}
      ${v.settings.allPlay ? `<span class="legend-star">${icon('star')}${t('allPlay')}</span>` : ''}
    </div>`;
}

function rulesHTML() {
  return `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="rules-title">
    <div class="backdrop" data-a="rules"></div>
    <div class="modal-card">
      <button class="icon-btn close" data-a="rules" aria-label="${t('close')}">${icon('x')}</button>
      <h2 id="rules-title">${t('rulesTitle')}</h2>
      <ol class="rules">${t('rules').split('\n').map((l) => `<li>${l}</li>`).join('')}</ol>
      <div class="types-legend">${TYPES.map(
        (k) => `<div class="tl type-${k}"><span class="ti">${icon(k)}</span><div><b>${t('type_' + k)}</b><p>${t('rule_' + k)}</p></div></div>`,
      ).join('')}</div>
      <p class="muted small">${t('rulesOnline')}</p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- events

const actions = {
  lang: (d) => {
    app.lang = d.v;
    store.set('lang', d.v);
    render();
  },
  mute: () => {
    app.muted = !app.muted;
    store.set('muted', app.muted);
    render();
  },
  rules: () => {
    app.ui.rules = !app.ui.rules;
    render();
  },
  home: () => {
    const s = app.session;
    if (s?.kind === 'local' && s.state.phase !== 'over' && !confirm(t('confirmQuit'))) return;
    leave();
  },
  'home-force': () => leave(true),
  'go-setup': () => {
    app.setup = defaultSetup();
    app.screen = 'setup';
    render();
  },
  'go-host': () => {
    app.screen = 'host';
    render();
  },
  continue: () => {
    const s = store.get('local');
    if (s?.teams) startLocal(s);
  },
  'team-add': () => {
    if (app.setup.teams.length < MAX_TEAMS) app.setup.teams.push({ name: teamName(app.setup.teams.length), players: '' });
    render();
  },
  'team-remove': (d) => {
    if (app.setup.teams.length > 2) app.setup.teams.splice(Number(d.i), 1);
    render();
  },
  'setup-opt': (d) => {
    app.setup.settings[d.k] = parseOpt(d.k, d.v);
    render();
  },
  'setup-start': () => newLocalGame(),
  choose: (d) => dispatch({ type: 'choose', difficulty: Number(d.d) }),
  reveal: () => {
    app.ui.reveal = !app.ui.reveal;
    render();
  },
  start: () => {
    app.ui.reveal = false;
    dispatch({ type: 'start' });
  },
  peek: () => {
    app.ui.peekUntil = Date.now() + 2500;
    render();
    setTimeout(render, 2600);
  },
  success: (d) => {
    const v = app.session.view();
    if (v.turn.all && d.team == null) {
      app.ui.pickTeam = true;
      render();
      return;
    }
    app.ui.pickTeam = false;
    dispatch({ type: 'success', team: d.team != null ? Number(d.team) : v.turn.team });
  },
  'pick-cancel': () => {
    app.ui.pickTeam = false;
    render();
  },
  fail: () => dispatch({ type: 'fail' }),
  next: () => dispatch({ type: 'next' }),
  skip: () => {
    if (confirm(t('confirmSkip'))) dispatch({ type: 'skip' });
  },
  end: () => {
    if (confirm(t('confirmEnd'))) dispatch({ type: 'end' });
  },
  'to-lobby': () => dispatch({ type: 'end' }),
  again: () => dispatch({ type: 'begin' }),
  team: (d) => dispatch({ type: 'team', team: Number(d.i) }),
  kick: (d) => {
    if (confirm(t('confirmKick', { name: d.name }))) dispatch({ type: 'kick', pid: d.pid });
  },
  begin: () => dispatch({ type: 'begin' }),
  opt: (d) => {
    const settings = d.k === 'teams' ? { teams: Number(d.v), names: [0, 1, 2, 3].map(teamName) } : { [d.k]: parseOpt(d.k, d.v) };
    dispatch({ type: 'settings', settings });
  },
  'copy-link': async () => {
    try {
      await navigator.clipboard.writeText(roomLink());
      toast(t('copied'));
    } catch {
      prompt(t('copyLink'), roomLink());
    }
  },
  share: async () => {
    try {
      await navigator.share({ title: 'Aktivko', text: t('shareText'), url: roomLink() });
    } catch {}
  },
  retry: () => {
    const s = app.session;
    if (s?.kind !== 'client') return;
    s.close();
    startClient(s.code, store.get('name', ''));
    render();
  },
};

const inputs = {
  'team-name': (el) => (app.setup.teams[Number(el.dataset.i)].name = el.value),
  'team-players': (el) => (app.setup.teams[Number(el.dataset.i)].players = el.value),
  custom: (el) => (app.setup.custom = el.value),
};

const changes = {
  'team-name': (el) => dispatch({ type: 'teamName', team: Number(el.dataset.i), name: el.value }),
  custom: (el) => dispatch({ type: 'settings', settings: { custom: splitWords(el.value) } }),
};

const submits = {
  'join-code': (f) => {
    const code = cleanCode(f.elements.code.value);
    if (!code) return;
    app.ui.joinCode = code;
    app.screen = 'join';
    render();
    document.getElementById('join-name')?.focus();
  },
  host: (f) => {
    const name = f.elements.name.value.trim();
    if (!name) return;
    store.set('name', name.slice(0, 20));
    startHost(null);
    render();
  },
  join: (f) => {
    const code = cleanCode(f.elements.code.value);
    const name = f.elements.name.value.trim();
    if (!code || !name) return;
    store.set('name', name.slice(0, 20));
    startClient(code, name.slice(0, 20));
    render();
  },
  guess: (f) => {
    const text = f.elements.guess.value.trim();
    if (text) dispatch({ type: 'guess', text });
    f.elements.guess.value = '';
    f.elements.guess.focus();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  unlockAudio();
  const fn = actions[el.dataset.a];
  if (fn) {
    e.preventDefault();
    fn(el.dataset, el);
  }
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-in]');
  if (el) inputs[el.dataset.in]?.(el);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-ch]');
  if (el) changes[el.dataset.ch]?.(el);
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f) return;
  e.preventDefault();
  unlockAudio();
  submits[f.dataset.form]?.(f);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && app.ui.rules) {
    app.ui.rules = false;
    render();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') keepAwake(app.screen === 'play' && !!app.session);
});
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    fitBoard();
    app.pad.resize();
  }, 120);
});
setInterval(updateTimer, 200);

// ------------------------------------------------------------------ boot

function boot() {
  const room = cleanCode(new URLSearchParams(location.search).get('room'));
  const hosted = tab.get('host');
  const joined = tab.get('client');
  if (hosted?.state && hosted.code) {
    startHost(hosted);
  } else if (room) {
    if (joined?.code === room && joined.name) startClient(room, joined.name);
    else {
      app.ui.joinCode = room;
      app.screen = 'join';
    }
  }
  render();
}

boot();
