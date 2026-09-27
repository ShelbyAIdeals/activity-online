// End-to-end browser test: a one-phone game, a full game to the finish in dark
// mode, and a four-player online room over real PeerJS connections.
//
//   npm i -D playwright-core && npx playwright install chromium
//   npm start            # in another terminal
//   npm run e2e          # BASE=https://... npm run e2e to test the live site
//
// CHROME_PATH can point at an existing Chrome/Chromium instead.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://localhost:8080/';
const OUT = fileURLToPath(new URL('../e2e-shots/', import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const errors = [];
function watch(page, tag) {
  page.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag} console: ${m.text()}`); });
  page.on('dialog', (d) => d.accept());
}
async function inkOn(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.pad canvas');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 200) n++;
    return n;
  });
}
async function scribble(page) {
  const box = await page.locator('.pad canvas').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  for (let i = 0; i < 20; i++) await page.mouse.move(box.x + 30 + i * 10, box.y + 30 + Math.sin(i) * 30 + i * 5, { steps: 2 });
  await page.mouse.up();
}

// ---------------- local game, phone size
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'en-US' });
  const page = await ctx.newPage();
  watch(page, 'local');
  await page.goto(BASE);
  await page.waitForSelector('.title');
  await page.screenshot({ path: OUT + '01-home-phone.png', fullPage: true });
  await page.click('[data-a="go-setup"]');
  await page.fill('#tp-0', 'Ana, Bor');
  await page.fill('#tp-1', 'Cene, Dara');
  await page.click('[data-a="team-add"]');
  await page.click('[data-a="setup-opt"][data-k="timer"][data-v="45"]');
  await page.screenshot({ path: OUT + '02-setup-phone.png', fullPage: true });
  await page.click('[data-a="setup-start"]');
  await page.waitForSelector('.diff-btn');
  await page.screenshot({ path: OUT + '03-choose-phone.png', fullPage: true });
  const passText = await page.textContent('.pass');
  console.log('local pass text:', passText.trim());
  await page.click('[data-a="choose"][data-d="4"]');
  await page.click('.word-card.covered');
  const word = (await page.textContent('.word')).trim();
  console.log('local word:', word);
  await page.screenshot({ path: OUT + '04-ready-phone.png', fullPage: true });
  await page.click('[data-a="start"]');
  await page.waitForSelector('#timer');
  const type = await page.evaluate(() => JSON.parse(localStorage.getItem('aktivko.local')).turn.type);
  console.log('local field type:', type);
  if (type === 'draw') {
    await page.waitForSelector('.pad canvas');
    await scribble(page);
    console.log('local ink pixels:', await inkOn(page));
  }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: OUT + '05-play-phone.png', fullPage: true });
  await page.click('[data-a="success"]');
  if (await page.locator('.pick').count()) await page.click('[data-a="success"][data-team="0"]');
  await page.waitForSelector('.result');
  await page.screenshot({ path: OUT + '06-result-phone.png', fullPage: true });
  const pos = await page.evaluate(() => JSON.parse(localStorage.getItem('aktivko.local')).teams.map((t) => t.pos));
  console.log('local positions after turn 1:', pos);
  await page.click('[data-a="next"]');
  // reload keeps the game
  await page.reload();
  await page.waitForSelector('[data-a="continue"]');
  await page.click('[data-a="continue"]');
  await page.waitForSelector('.diff-btn');
  console.log('local continue ok, team:', (await page.textContent('.turn-team')).trim());
  // language switch
  await page.click('[data-a="lang"][data-v="sl"]');
  console.log('sl field:', (await page.textContent('.field-type')).trim());
  await page.click('[data-a="rules"]');
  await page.screenshot({ path: OUT + '07-rules-sl.png' });
  await page.click('.modal .close');
  await ctx.close();
}

// ---------------- local game, desktop, dark mode, force a win
{
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  watch(page, 'desktop');
  await page.goto(BASE);
  await page.screenshot({ path: OUT + '08-home-desktop-dark.png' });
  await page.click('[data-a="go-setup"]');
  await page.click('[data-a="setup-opt"][data-k="length"][data-v="30"]');
  await page.click('[data-a="setup-start"]');
  for (let turn = 0; turn < 30; turn++) {
    await page.click('[data-a="choose"][data-d="5"]');
    await page.click('[data-a="start"]');
    await page.click('[data-a="success"]');
    if (await page.locator('.pick').count()) await page.click('[data-a="success"][data-team="0"]');
    if (await page.locator('.over').count()) break;
    if (turn === 2) await page.screenshot({ path: OUT + '09-result-desktop-dark.png' });
    await page.click('[data-a="next"]');
  }
  await page.waitForSelector('.over');
  console.log('winner:', (await page.textContent('.over h2')).trim());
  await page.waitForTimeout(600);
  await page.screenshot({ path: OUT + '10-over-desktop-dark.png' });
  await ctx.close();
}

// ---------------- online room: host + two players
{
  const mk = async (tag, vp = { width: 390, height: 844 }) => {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    watch(page, tag);
    return page;
  };
  const host = await mk('host', { width: 1280, height: 860 });
  await host.goto(BASE);
  await host.click('[data-a="go-host"]');
  await host.fill('#host-name', 'Hana');
  await host.click('form[data-form="host"] button');
  await host.waitForSelector('.code', { timeout: 30000 });
  const code = (await host.textContent('.code')).trim();
  console.log('room code:', code);

  const players = [];
  for (const name of ['Ana', 'Bor', 'Cene']) {
    const p = await mk(name);
    await p.goto(BASE + '?room=' + code);
    await p.fill('#join-name', name);
    await p.click('form[data-form="join"] button');
    await p.waitForSelector('.lobby', { timeout: 30000 });
    players.push(p);
  }
  await host.waitForFunction(() => document.querySelectorAll('.team-col li:not(.muted)').length === 4, null, { timeout: 15000 });
  await host.screenshot({ path: OUT + '11-lobby-host.png', fullPage: true });
  await players[0].screenshot({ path: OUT + '12-lobby-player.png', fullPage: true });

  // host changes a setting, players see it
  await host.click('[data-a="opt"][data-k="timer"][data-v="90"]');
  await players[1].waitForFunction(() => document.querySelector('.summary')?.textContent.includes('90 s'), null, { timeout: 10000 });
  console.log('setting synced to players');

  // guarantee a draw field first so we can test live drawing
  await host.click('[data-a="begin"]');
  const all = [host, ...players];
  await host.waitForSelector('.turn');
  const state = await host.evaluate(() => JSON.parse(sessionStorage.getItem('aktivko.host')).state);
  const perfPid = state.turn.performer;
  const names = { Hana: host, Ana: players[0], Bor: players[1], Cene: players[2] };
  const perfName = state.players[perfPid].name;
  const perf = names[perfName];
  const teamPids = state.teams[state.turn.team].players;
  const mateName = teamPids.map((p) => state.players[p].name).find((n) => n !== perfName);
  const rivalName = state.teams[1 - state.turn.team].players.map((p) => state.players[p].name)[0];
  console.log('performer:', perfName, 'mate:', mateName, 'rival:', rivalName, 'type:', state.turn.type, 'all:', state.turn.all);

  await perf.waitForSelector('.diff-btn');
  console.log('non-performer sees:', (await names[mateName].textContent('.wait')).trim());
  await perf.click('[data-a="choose"][data-d="3"]');
  await perf.waitForSelector('.word-card');
  const word = (await perf.textContent('.word')).trim();
  const leak = await names[mateName].evaluate((w) => document.body.innerText.includes(w), word);
  console.log('word:', word, '| visible to teammate before turn ends:', leak);
  await perf.click('[data-a="start"]');
  await names[mateName].waitForSelector('#timer');
  await names[mateName].waitForTimeout(1500);
  const secs = await names[mateName].textContent('#timer span');
  console.log('teammate timer shows:', secs);

  if (state.turn.type === 'draw') {
    await perf.waitForSelector('.pad canvas');
    await scribble(perf);
    await names[rivalName].waitForTimeout(800);
    console.log('ink on performer:', await inkOn(perf), 'ink on rival screen:', await inkOn(names[rivalName]));
  }
  await perf.screenshot({ path: OUT + '13-play-performer.png', fullPage: true });
  await names[mateName].screenshot({ path: OUT + '14-play-guesser.png', fullPage: true });

  if (!state.turn.all) {
    const rivalCanGuess = await names[rivalName].locator('#guess').count();
    console.log('rival has guess box:', rivalCanGuess > 0);
  }
  await names[mateName].fill('#guess', 'banana split');
  await names[mateName].press('#guess', 'Enter');
  await names[mateName].fill('#guess', word.toUpperCase());
  await names[mateName].press('#guess', 'Enter');
  for (const p of all) await p.waitForSelector('.result', { timeout: 10000 });
  console.log('result on all screens:', (await players[2].textContent('.result h3')).trim(), '|', (await players[2].textContent('.result')).replace(/\s+/g, ' ').trim());
  await names[rivalName].screenshot({ path: OUT + '15-result-player.png', fullPage: true });

  // reconnect: one player reloads mid-game and comes back as the same player
  await players[2].reload();
  await players[2].waitForSelector('.result, .turn', { timeout: 30000 });
  const after = await host.evaluate(() => Object.values(JSON.parse(sessionStorage.getItem('aktivko.host')).state.players).map((p) => `${p.name}:${p.online}`));
  console.log('players after reload:', after.join(', '));

  await players[1].click('[data-a="next"]');
  await host.waitForSelector('.diff-btn, .wait', { timeout: 10000 });
  console.log('next turn team:', (await host.textContent('.turn-team')).trim());
  for (const p of all) await p.context().close();
}

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
