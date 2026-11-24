// The site must keep answering while the node is down. Starts the front door, kills the node behind it and checks every page.
import { spawn, execSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), PORT = 20000 + Math.floor(Math.random() * 2000), BASE = 'http://127.0.0.1:' + PORT, DATA = path.join(os.tmpdir(), 'l2-front-' + PORT + '.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) pass++; else fail++; console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond ? '' : '  ' + extra)); };
const get = async (p) => { try { const r = await fetch(BASE + p, { signal: AbortSignal.timeout(12000) }); return { status: r.status, node: r.headers.get('x-node'), text: await r.text() }; } catch (e) { return { status: 0, text: String(e.message) }; } };
const front = spawn(process.execPath, ['server/start.js'], { cwd: ROOT, env: { ...process.env, PORT, DATA_PATH: DATA, L2_DEV: '1', NODE_ENV: 'test', DOOR_SECRET: '', AUTHORITY_SECRET: '', DOOR_ADDRESS: '', SETTLEMENT_ADDRESS: '', AUTHORITY_KEY: '' }, stdio: ['ignore', 'pipe', 'inherit'] });
let log = ''; front.stdout.on('data', (d) => { log += d; });
const nodePid = () => { const out = process.platform === 'win32' ? execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${PORT + 1}`, { encoding: 'utf8' }) : execSync(`lsof -ti tcp:${PORT + 1} -s tcp:LISTEN`, { encoding: 'utf8' }); return +out.trim().split(/\s+/).pop(); };
try {
  for (let i = 0; i < 60 && !log.includes('producing'); i++) await sleep(250);
  await sleep(6000); // long enough for the node's first save
  const PAGES = ['/', '/app', '/explorer', '/docs', '/style.css', '/common.js', '/sw.js'];
  for (const p of PAGES) ok('up: ' + p, (await get(p)).status === 200);
  const live = await get('/api/chain'); ok('up: /api/chain', live.status === 200 && JSON.parse(live.text).head >= 0, live.text.slice(0, 80));
  ok('up: /api/blocks', (await get('/api/blocks')).status === 200); ok('up: /api/coins', (await get('/api/coins')).status === 200);
  ok('healthz says running', JSON.parse((await get('/healthz')).text).node === 'running');

  // make the node unable to come back for a while, then kill it
  const pid = nodePid(); process.kill(pid); const killedAt = Date.now(); await sleep(400);
  for (const p of PAGES) ok('node down: ' + p + ' still 200', (await get(p)).status === 200);
  const stale = await get('/api/chain'); ok('node down: /api/chain answers from the last good copy', stale.status === 200 && (stale.node === 'catching-up' || JSON.parse(stale.text).head >= 0), stale.status + ' ' + stale.text.slice(0, 80));
  const fresh = await get('/api/tx/' + 'a'.repeat(64)); ok('node down: uncached read is a clean 503 or already recovered', fresh.status === 503 || fresh.status === 404, String(fresh.status));
  ok('node down: never a gateway error', ![502, 504, 0].includes(stale.status) && ![502, 504, 0].includes(fresh.status));
  ok('healthz still 200', (await get('/healthz')).status === 200);

  let back = false; for (let i = 0; i < 80 && !back; i++) { await sleep(250); const r = await get('/api/chain'); back = r.status === 200 && r.node !== 'catching-up' && nodePidSafe() !== pid; }
  function nodePidSafe() { try { return nodePid(); } catch { return pid; } }
  ok('node comes back by itself (' + (Date.now() - killedAt) + ' ms)', back);
  const after = await get('/api/chain'); ok('state survived the restart (at most a few seconds of blocks replayed)', after.status === 200 && JSON.parse(after.text).head >= JSON.parse(live.text).head - 4 && JSON.parse(after.text).head > 0, after.text.slice(0, 80));
} finally { front.kill(); await sleep(600); try { fs.unlinkSync(DATA); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
