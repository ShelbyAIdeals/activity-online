import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS } from '../js/words.js';
import { createState, apply, viewFor, makeBoard, matches, defaultSettings, canStart, teamOf, TYPES } from '../js/engine.js';

function localGame(opts = {}) {
  const players = { L1: { name: 'Ana', online: true }, L2: { name: 'Bor', online: true }, L3: { name: 'Cene', online: true } };
  const s = createState({
    mode: 'local',
    settings: { ...defaultSettings('en'), ...opts },
    teams: [{ name: 'Red', players: ['L1', 'L2'] }, { name: 'Blue', players: ['L3'] }],
    players,
  });
  assert.equal(apply(s, { type: 'begin' }), true);
  return s;
}

function onlineGame() {
  const s = createState({ mode: 'online', settings: defaultSettings('sl'), teams: [{ name: 'A' }, { name: 'B' }], host: 'host1' });
  apply(s, { type: 'join', name: 'Host' }, 'host1');
  apply(s, { type: 'join', name: 'Ana' }, 'ana111');
  apply(s, { type: 'join', name: 'Bor' }, 'bor111');
  apply(s, { type: 'join', name: 'Cene' }, 'cene11');
  return s;
}

test('word decks: 150 words per bucket, no duplicates', () => {
  for (const lang of ['en', 'sl']) {
    const all = [];
    for (const d of [3, 4, 5]) {
      assert.ok(WORDS[lang][d].length >= 150, `${lang} ${d}`);
      all.push(...WORDS[lang][d]);
    }
    assert.equal(new Set(all.map((w) => w.toLowerCase())).size, all.length, lang);
  }
});

test('board mixes activities evenly and never repeats one back to back', () => {
  for (let run = 0; run < 50; run++) {
    const b = makeBoard(45, true);
    assert.equal(b.length, 45);
    for (let i = 1; i < b.length; i++) assert.notEqual(b[i].type, b[i - 1].type);
    for (const type of TYPES) assert.equal(b.filter((f) => f.type === type).length, 15);
    assert.deepEqual(b.map((f, i) => (f.all ? i : -1)).filter((i) => i >= 0), [6, 13, 20, 27, 34, 41]);
  }
  assert.equal(makeBoard(30, false).some((f) => f.all), false);
});

test('a local turn: choose, start, guess, move, rotate', () => {
  const s = localGame({ allPlay: false });
  assert.equal(s.phase, 'choose');
  assert.equal(s.turn.performer, 'L1');
  assert.equal(apply(s, { type: 'start' }), false, 'cannot start before picking a card');
  assert.equal(apply(s, { type: 'choose', difficulty: 4 }), true);
  assert.equal(s.phase, 'ready');
  assert.ok(WORDS.en[4].includes(s.turn.word));
  apply(s, { type: 'start' }, null, 1000);
  assert.equal(s.turn.endsAt, 61000);
  assert.equal(apply(s, { type: 'tick' }, null, 30000), false);
  assert.equal(apply(s, { type: 'tick' }, null, 61000), true);
  assert.equal(s.turn.timeUp, true);
  apply(s, { type: 'success' });
  assert.equal(s.phase, 'result');
  assert.equal(s.teams[0].pos, 4);
  assert.deepEqual([s.turn.result.from, s.turn.result.to], [0, 4]);
  apply(s, { type: 'next' });
  assert.equal(s.current, 1);
  assert.equal(s.turn.performer, 'L3');
  apply(s, { type: 'choose', difficulty: 3 });
  apply(s, { type: 'fail' });
  assert.equal(s.teams[1].pos, 0);
  apply(s, { type: 'next' });
  assert.equal(s.round, 2);
  assert.equal(s.turn.performer, 'L2', 'the next player in the team performs');
});

test('the field a team stands on decides the activity', () => {
  const s = localGame();
  s.teams[0].pos = 0;
  assert.equal(s.turn.type, s.board[0].type);
  apply(s, { type: 'choose', difficulty: 5 });
  apply(s, { type: 'start' });
  apply(s, { type: 'success' });
  apply(s, { type: 'next' });
  apply(s, { type: 'skip' });
  apply(s, { type: 'next' });
  assert.equal(s.turn.type, s.board[5].type);
});

test('star fields let another team take the points', () => {
  const s = localGame();
  s.board[0].all = true;
  s.turn.all = true;
  apply(s, { type: 'choose', difficulty: 3 });
  apply(s, { type: 'start' });
  assert.equal(apply(s, { type: 'success', team: 7 }), false);
  apply(s, { type: 'success', team: 1 });
  assert.equal(s.teams[0].pos, 0);
  assert.equal(s.teams[1].pos, 3);
});

test('reaching the finish ends the game', () => {
  const s = localGame({ length: 30 });
  s.teams[0].pos = 28;
  apply(s, { type: 'choose', difficulty: 5 });
  apply(s, { type: 'start' });
  apply(s, { type: 'success' });
  assert.equal(s.phase, 'over');
  assert.equal(s.winner, 0);
  assert.equal(s.teams[0].pos, 30);
  assert.equal(apply(s, { type: 'begin' }), true, 'play again');
  assert.equal(s.teams[0].pos, 0);
  assert.equal(s.winner, null);
});

test('words do not repeat until the bucket is used up', () => {
  const s = localGame({ custom: [] });
  const seen = new Set();
  for (let i = 0; i < WORDS.en[3].length; i++) {
    s.phase = 'choose';
    apply(s, { type: 'choose', difficulty: 3 });
    assert.ok(!seen.has(s.turn.word), s.turn.word);
    seen.add(s.turn.word);
  }
  s.phase = 'choose';
  apply(s, { type: 'choose', difficulty: 3 });
  assert.ok(seen.has(s.turn.word), 'recycles once exhausted');
});

test('guess matching ignores case, accents, spaces and articles', () => {
  assert.ok(matches('Deja vu', 'déjà vu'));
  assert.ok(matches('cebela', 'čebela'));
  assert.ok(matches('the eiffel tower', 'Eiffel Tower'));
  assert.ok(matches('vacuumcleaner', 'vacuum cleaner'));
  assert.ok(!matches('cat', 'cats'));
  assert.ok(!matches('', 'x'));
  assert.ok(!matches('!!', 'x'));
});

test('online: teams fill evenly and every team needs a player', () => {
  const s = onlineGame();
  assert.deepEqual(s.teams.map((t) => t.players.length), [2, 2]);
  assert.ok(canStart(s));
  // host1 and bor111 are in team 0, ana111 and cene11 in team 1.
  apply(s, { type: 'team', team: 0 }, 'cene11');
  apply(s, { type: 'team', team: 0 }, 'ana111');
  assert.equal(canStart(s), false);
  assert.equal(apply(s, { type: 'begin' }, 'host1'), false);
});

test('online: only the host runs the room', () => {
  const s = onlineGame();
  assert.equal(apply(s, { type: 'settings', settings: { timer: 90 } }, 'ana111'), false);
  assert.equal(apply(s, { type: 'begin' }, 'ana111'), false);
  assert.equal(apply(s, { type: 'kick', pid: 'bor111' }, 'ana111'), false);
  assert.equal(apply(s, { type: 'settings', settings: { timer: 90, teams: 3, names: ['A', 'B', 'C'] } }, 'host1'), true);
  assert.equal(s.settings.timer, 90);
  assert.equal(s.teams.length, 3);
  assert.equal(apply(s, { type: 'settings', settings: { timer: 7 } }, 'host1'), true);
  assert.equal(s.settings.timer, 90, 'invalid values are ignored');
  apply(s, { type: 'settings', settings: { teams: 2 } }, 'host1');
  assert.equal(Object.values(s.teams).flatMap((t) => t.players).length, 4, 'nobody lost when a team is removed');
  assert.equal(apply(s, { type: 'begin' }, 'host1'), true);
});

test('online: the word is hidden from everyone but the performer', () => {
  const s = onlineGame();
  apply(s, { type: 'begin' }, 'host1');
  const perf = s.turn.performer;
  const other = Object.keys(s.players).find((p) => p !== perf && p !== s.host);
  assert.equal(apply(s, { type: 'choose', difficulty: 3 }, other), false, 'only the performer picks');
  apply(s, { type: 'choose', difficulty: 3 }, perf);
  assert.ok(s.turn.word);
  assert.equal(viewFor(s, perf).turn.word, s.turn.word);
  assert.equal(viewFor(s, other).turn.word, null);
  assert.equal(viewFor(s, other).used, undefined);
  apply(s, { type: 'start' }, perf, 0);
  assert.equal(viewFor(s, other, 10000).turn.remaining, 50000);
  apply(s, { type: 'fail' }, perf);
  assert.equal(viewFor(s, other).turn.word, s.turn.word, 'revealed after the turn');
});

test('online: host words stay secret from players', () => {
  const s = onlineGame();
  apply(s, { type: 'settings', settings: { custom: ['Secret', 'secret', '  Joke  ', 42] } }, 'host1');
  assert.deepEqual(s.settings.custom, ['Secret', 'Joke']);
  assert.deepEqual(viewFor(s, 'host1').settings.custom, ['Secret', 'Joke']);
  assert.deepEqual(viewFor(s, 'ana111').settings.custom, []);
  assert.equal(viewFor(s, 'ana111').settings.customCount, 2);
});

test('online: typed guesses count only for the guessing team', () => {
  const s = onlineGame();
  apply(s, { type: 'begin' }, 'host1');
  s.board[0].all = false;
  s.turn.all = false;
  const perf = s.turn.performer;
  apply(s, { type: 'choose', difficulty: 4 }, perf);
  apply(s, { type: 'start' }, perf);
  const word = s.turn.word;
  const mate = s.teams[s.turn.team].players.find((p) => p !== perf);
  const rival = s.teams[1 - s.turn.team].players[0];
  assert.equal(apply(s, { type: 'guess', text: word }, perf), false, 'performer cannot guess');
  assert.equal(apply(s, { type: 'guess', text: word }, rival), false, 'other team cannot guess');
  assert.equal(apply(s, { type: 'guess', text: 'nope' }, mate), true);
  assert.equal(s.phase, 'play');
  assert.equal(apply(s, { type: 'guess', text: word.toUpperCase() }, mate), true);
  assert.equal(s.phase, 'result');
  assert.equal(s.turn.result.by, mate);
  assert.equal(s.teams[s.turn.team].pos, 4);
});

test('online: a guess after time is up does not count automatically', () => {
  const s = onlineGame();
  apply(s, { type: 'begin' }, 'host1');
  const perf = s.turn.performer;
  apply(s, { type: 'choose', difficulty: 3 }, perf);
  apply(s, { type: 'start' }, perf, 0);
  apply(s, { type: 'tick' }, 'host1', 60001);
  const mate = s.teams[s.turn.team].players.find((p) => p !== perf);
  apply(s, { type: 'guess', text: s.turn.word }, mate);
  assert.equal(s.phase, 'play');
  assert.equal(s.guesses.at(-1).ok, false);
});

test('online: offline players are skipped as performers; kicked players are removed', () => {
  const s = onlineGame();
  const team0 = s.teams[0].players;
  apply(s, { type: 'leave' }, team0[0]);
  apply(s, { type: 'begin' }, 'host1');
  assert.equal(s.turn.performer, team0[1]);
  assert.equal(apply(s, { type: 'kick', pid: 'host1' }, 'host1'), false, 'host cannot kick themself');
  apply(s, { type: 'kick', pid: 'cene11' }, 'host1');
  assert.equal(s.players.cene11, undefined);
  assert.equal(teamOf(s, 'cene11'), -1);
});
