// Game rules and state machine. Pure logic with no DOM or network access, so the
// same code runs a pass-the-phone game and the host of an online room.
import { WORDS } from './words.js';

export const TYPES = ['draw', 'describe', 'mime'];
export const TEAM_COLORS = ['#e5484d', '#3e63dd', '#2f9e5b', '#e3a008'];
export const LENGTHS = { short: 30, normal: 45, long: 60 };
export const TIMERS = [45, 60, 90, 120];
export const DIFFICULTIES = [3, 4, 5];
export const MAX_TEAMS = 4;
export const MAX_PLAYERS = 24;
const ALL_PLAY_EVERY = 7;
const MAX_CUSTOM = 300;

export function defaultSettings(lang) {
  return { lang: lang === 'sl' ? 'sl' : 'en', length: LENGTHS.normal, timer: 60, allPlay: true, custom: [] };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function clean(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function cleanCustom(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const w = clean(item, 40);
    const key = norm(w);
    if (!w || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= MAX_CUSTOM) break;
  }
  return out;
}

// Fields 0..length-1 each carry an activity; `length` itself is the finish.
// Activities come in shuffled blocks of three so they stay evenly mixed and
// never repeat back to back.
export function makeBoard(length, allPlay) {
  const board = [];
  let last = null;
  while (board.length < length) {
    const block = shuffle([...TYPES]);
    if (block[0] === last) block.push(block.shift());
    for (const type of block) if (board.length < length) board.push({ type, all: false });
    last = board[board.length - 1].type;
  }
  if (allPlay) for (let i = ALL_PLAY_EVERY - 1; i < length - 1; i += ALL_PLAY_EVERY) board[i].all = true;
  return board;
}

export function createState({ mode, settings, teams, players = {}, host = null, used = [] }) {
  const s = {
    mode,
    phase: 'lobby',
    settings: { ...defaultSettings(settings?.lang), ...settings },
    board: [],
    host,
    teams: teams.map((t, i) => ({ name: t.name, color: TEAM_COLORS[i], pos: 0, players: [...(t.players || [])], next: 0 })),
    players,
    current: 0,
    round: 1,
    turn: null,
    turnId: 0,
    guesses: [],
    winner: null,
    used: Array.isArray(used) ? [...used] : [],
  };
  s.settings.custom = cleanCustom(s.settings.custom);
  s.board = makeBoard(s.settings.length, s.settings.allPlay);
  return s;
}

export function teamOf(s, pid) {
  return pid == null ? -1 : s.teams.findIndex((t) => t.players.includes(pid));
}

export function canStart(s) {
  if (s.teams.length < 2) return false;
  if (s.mode === 'local') return true;
  return s.teams.every((t) => t.players.some((p) => s.players[p]?.online));
}

// Lowercase, no accents, no punctuation or spaces, no leading article: lets
// "Déjà vu", "deja-vu" and "dejavu" all match, and "čebela" match "cebela".
export function norm(value) {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/^\s*(the|an|a|to)\s+/, '')
    .replace(/[^a-z0-9]/g, '');
}

export function matches(guess, word) {
  const g = norm(guess);
  return g.length > 0 && g === norm(word);
}

function validTeam(s, i) {
  return Number.isInteger(i) && i >= 0 && i < s.teams.length;
}

function pickPerformer(s, team) {
  const list = team.players;
  if (!list.length) return null;
  for (let k = 0; k < list.length; k++) {
    const i = (team.next + k) % list.length;
    if (s.mode === 'local' || s.players[list[i]]?.online) {
      team.next = i;
      return list[i];
    }
  }
  return list[team.next % list.length];
}

function beginTurn(s) {
  const team = s.teams[s.current];
  const field = s.board[Math.min(team.pos, s.board.length - 1)];
  s.turn = {
    team: s.current,
    performer: pickPerformer(s, team),
    type: field.type,
    all: field.all,
    difficulty: null,
    word: null,
    endsAt: null,
    timeUp: false,
    result: null,
  };
  s.turnId++;
  s.guesses = [];
  s.phase = 'choose';
}

function startGame(s) {
  s.board = makeBoard(s.settings.length, s.settings.allPlay);
  for (const t of s.teams) {
    t.pos = 0;
    t.next = 0;
  }
  s.current = 0;
  s.round = 1;
  s.winner = null;
  beginTurn(s);
}

function drawWord(s, d) {
  const lang = WORDS[s.settings.lang] ? s.settings.lang : 'en';
  const pool = [...WORDS[lang][d], ...s.settings.custom];
  const used = new Set(s.used);
  let fresh = pool.filter((w) => !used.has(w));
  if (!fresh.length) {
    // Whole bucket played: forget it and start over.
    const inPool = new Set(pool);
    s.used = s.used.filter((w) => !inPool.has(w));
    fresh = pool;
  }
  const word = fresh[Math.floor(Math.random() * fresh.length)];
  s.used.push(word);
  return word;
}

function resolve(s, team, { skipped = false, by = null } = {}) {
  const t = s.turn;
  const r = { success: team != null, team, by, skipped, from: null, to: null };
  if (team != null) {
    const tm = s.teams[team];
    r.from = tm.pos;
    tm.pos = Math.min(s.settings.length, tm.pos + (t.difficulty || 0));
    r.to = tm.pos;
    if (tm.pos >= s.settings.length) s.winner = team;
  }
  t.result = r;
  t.endsAt = null;
  s.phase = s.winner != null ? 'over' : 'result';
}

function advance(s) {
  const tm = s.teams[s.current];
  if (tm.players.length) tm.next = (tm.next + 1) % tm.players.length;
  s.current = (s.current + 1) % s.teams.length;
  if (s.current === 0) s.round++;
  beginTurn(s);
}

function join(s, pid, name) {
  if (typeof pid !== 'string' || !pid) return false;
  const n = clean(name, 20) || 'Player';
  const p = s.players[pid];
  if (p) {
    p.name = n;
    p.online = true;
  } else {
    if (Object.keys(s.players).length >= MAX_PLAYERS) return false;
    s.players[pid] = { name: n, online: true };
  }
  if (teamOf(s, pid) < 0) {
    let best = 0;
    s.teams.forEach((t, i) => {
      if (t.players.length < s.teams[best].players.length) best = i;
    });
    s.teams[best].players.push(pid);
  }
  return true;
}

function setTeamCount(s, n, names) {
  while (s.teams.length < n) {
    const i = s.teams.length;
    s.teams.push({ name: clean(names?.[i], 24) || `Team ${i + 1}`, color: TEAM_COLORS[i], pos: 0, players: [], next: 0 });
  }
  while (s.teams.length > n) {
    const gone = s.teams.pop();
    for (const pid of gone.players) {
      let best = 0;
      s.teams.forEach((t, i) => {
        if (t.players.length < s.teams[best].players.length) best = i;
      });
      s.teams[best].players.push(pid);
    }
  }
}

function changeSettings(s, v) {
  if (!v || typeof v !== 'object') return false;
  if (v.lang === 'en' || v.lang === 'sl') s.settings.lang = v.lang;
  if (Object.values(LENGTHS).includes(v.length)) s.settings.length = v.length;
  if (TIMERS.includes(v.timer)) s.settings.timer = v.timer;
  if (typeof v.allPlay === 'boolean') s.settings.allPlay = v.allPlay;
  if (Array.isArray(v.custom)) s.settings.custom = cleanCustom(v.custom);
  if (Number.isInteger(v.teams) && v.teams >= 2 && v.teams <= MAX_TEAMS) setTeamCount(s, v.teams, v.names);
  s.board = makeBoard(s.settings.length, s.settings.allPlay);
  return true;
}

function guess(s, pid, text) {
  const t = s.turn;
  if (s.mode === 'local' || s.phase !== 'play' || !s.players[pid] || pid === t.performer) return false;
  const team = teamOf(s, pid);
  if (team < 0 || (!t.all && team !== t.team)) return false;
  const g = clean(text, 60);
  if (!g) return false;
  const ok = !t.timeUp && matches(g, t.word);
  s.guesses.push({ pid, text: g, ok });
  if (s.guesses.length > 30) s.guesses.shift();
  if (ok) resolve(s, team, { by: pid });
  return true;
}

// Applies one action. `actor` is the player id doing it (null in a local
// game, where whoever holds the phone may do anything). Returns true when the
// state changed, false when the action was not allowed or did nothing.
export function apply(s, a, actor = null, now = Date.now()) {
  if (!a || typeof a.type !== 'string') return false;
  const local = s.mode === 'local';
  const isHost = local || (actor != null && actor === s.host);
  const t = s.turn;
  const isPerformer = isHost || (t != null && actor === t.performer);

  switch (a.type) {
    case 'join':
      return join(s, actor, a.name);

    case 'leave': {
      const p = s.players[actor];
      if (!p || !p.online) return false;
      p.online = false;
      return true;
    }

    case 'team': {
      const pid = isHost && typeof a.pid === 'string' ? a.pid : actor;
      if (!s.players[pid] || !validTeam(s, a.team) || teamOf(s, pid) === a.team) return false;
      if (t && pid === t.performer && (s.phase === 'ready' || s.phase === 'play')) return false;
      for (const tm of s.teams) tm.players = tm.players.filter((p) => p !== pid);
      s.teams[a.team].players.push(pid);
      return true;
    }

    case 'settings':
      return isHost && s.phase === 'lobby' && changeSettings(s, a.settings);

    case 'teamName': {
      const name = clean(a.name, 24);
      if (!isHost || !validTeam(s, a.team) || !name || name === s.teams[a.team].name) return false;
      s.teams[a.team].name = name;
      return true;
    }

    case 'kick': {
      if (!isHost || local || !s.players[a.pid] || a.pid === s.host) return false;
      delete s.players[a.pid];
      for (const tm of s.teams) tm.players = tm.players.filter((p) => p !== a.pid);
      return true;
    }

    case 'begin':
      if (!isHost || (s.phase !== 'lobby' && s.phase !== 'over') || !canStart(s)) return false;
      startGame(s);
      return true;

    case 'choose':
      if (s.phase !== 'choose' || !isPerformer || !DIFFICULTIES.includes(a.difficulty)) return false;
      t.difficulty = a.difficulty;
      t.word = drawWord(s, a.difficulty);
      s.phase = 'ready';
      return true;

    case 'start':
      if (s.phase !== 'ready' || !isPerformer) return false;
      t.endsAt = now + s.settings.timer * 1000;
      s.phase = 'play';
      return true;

    case 'tick':
      if (s.phase !== 'play' || t.timeUp || now < t.endsAt) return false;
      t.timeUp = true;
      return true;

    case 'guess':
      return guess(s, actor, a.text);

    case 'success': {
      if (s.phase !== 'play' || !isPerformer) return false;
      const team = t.all ? a.team : t.team;
      if (!validTeam(s, team)) return false;
      resolve(s, team);
      return true;
    }

    case 'fail':
      if ((s.phase !== 'play' && s.phase !== 'ready') || !isPerformer) return false;
      resolve(s, null);
      return true;

    case 'skip':
      if (!isHost || !['choose', 'ready', 'play'].includes(s.phase)) return false;
      resolve(s, null, { skipped: true });
      return true;

    case 'next':
      if (s.phase !== 'result' || (!local && !s.players[actor])) return false;
      advance(s);
      return true;

    case 'end':
      if (!isHost || local || s.phase === 'lobby') return false;
      s.phase = 'lobby';
      s.turn = null;
      s.winner = null;
      s.guesses = [];
      for (const tm of s.teams) tm.pos = 0;
      return true;
  }
  return false;
}

// What one player may see: the word only for the performer (or once the turn
// is over), the host's own words only for the host, and the time left instead
// of the host's clock.
export function viewFor(s, pid, now = Date.now()) {
  const { used, ...rest } = s;
  const v = JSON.parse(JSON.stringify(rest));
  if (s.mode !== 'local' && pid !== s.host) {
    v.settings.customCount = v.settings.custom.length;
    v.settings.custom = [];
  }
  const t = v.turn;
  if (t) {
    const reveal = s.mode === 'local' || pid === t.performer || v.phase === 'result' || v.phase === 'over';
    if (!reveal) t.word = null;
    t.remaining = t.endsAt != null ? Math.max(0, t.endsAt - now) : null;
    delete t.endsAt;
  }
  return v;
}
