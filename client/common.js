// Shared by every page: formatting, the API, the wallet, signing, toasts and the nav.
(() => {
  const B = window.BRAND, $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- numbers ----------
  const COIN_DEC = 6;
  function units(base, dec) { let s = String(base ?? '0'); const neg = s[0] === '-'; if (neg) s = s.slice(1); s = s.padStart(dec + 1, '0'); const i = s.slice(0, -dec) || '0', f = s.slice(-dec).replace(/0+$/, ''); return (neg ? '-' : '') + i + (f ? '.' + f : ''); }
  function parse(text, dec) { const t = String(text).trim().replace(/,/g, ''); if (!/^\d*\.?\d*$/.test(t) || !/\d/.test(t)) return null; const [i, f = ''] = t.split('.'); if (f.length > dec) return null; return BigInt((i || '0') + f.padEnd(dec, '0')).toString(); }
  function num(v, max = 4) { const n = +v; if (!isFinite(n)) return '0'; const a = Math.abs(n); if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M'; if (a >= 1e4) return (n / 1e3).toFixed(1) + 'K'; if (a === 0) return '0'; if (a < 0.0001) return n.toPrecision(2).replace(/e-(\d+)/, (m, e) => 'e-' + e); return n.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 2 : max }); }
  const amount = (base, dec, max) => num(units(base, dec), max);
  const usd = (v) => { const n = +v; if (!isFinite(n) || n === 0) return '$0'; const a = Math.abs(n); if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'; if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M'; if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'; if (a >= 1) return '$' + n.toFixed(2); if (a >= 0.01) return '$' + n.toFixed(4); return '$' + n.toPrecision(3); };
  const ago = (ms) => { const s = Math.max(0, (Date.now() - ms) / 1000); return s < 60 ? Math.floor(s) + 's ago' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'; };
  const short = (s, a = 6, b = 6) => (!s ? '' : s.length <= a + b + 3 ? s : s.slice(0, a) + '…' + s.slice(-b));
  const int = (n) => Number(n || 0).toLocaleString('en-US');

  // ---------- bytes ----------
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58enc(bytes) { let n = 0n; for (const b of bytes) n = (n << 8n) | BigInt(b); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const b of bytes) { if (b === 0) s = '1' + s; else break; } return s; }
  function b58dec(str) { let n = 0n; for (const c of str) { const v = B58.indexOf(c); if (v < 0) throw new Error('not base58'); n = n * 58n + BigInt(v); } const out = []; while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; } for (const c of str) { if (c === '1') out.unshift(0); else break; } return Uint8Array.from(out); }
  const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const sha256hex = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  function canon(v) { if (v === null || typeof v !== 'object') return JSON.stringify(v); if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']'; const k = Object.keys(v).filter((x) => v[x] !== undefined).sort(); return '{' + k.map((x) => JSON.stringify(x) + ':' + canon(v[x])).join(',') + '}'; }

  // ---------- API ----------
  // Reads are retried quietly while the node catches up; the page keeps what it already shows. Writes are never resent.
  let lagging = false;
  function lag(on) { if (on === lagging) return; lagging = on; let el = document.getElementById('l2-lag'); if (!el) { el = document.createElement('div'); el.id = 'l2-lag'; el.setAttribute('role', 'status'); el.textContent = 'Reconnecting to the node'; el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:9999;padding:8px 14px;border-radius:999px;font:500 12px/1 system-ui,sans-serif;letter-spacing:.04em;background:rgba(12,12,16,.92);color:#fff;border:1px solid rgba(255,255,255,.18);pointer-events:none;transition:opacity .3s'; document.body.appendChild(el); } el.style.opacity = on ? '1' : '0'; }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function api(path, opt = {}) {
    const read = !opt.body;
    for (let attempt = 0; ; attempt++) {
      let r = null; try { r = await fetch(path, { method: read ? 'GET' : 'POST', headers: { ...(read ? {} : { 'content-type': 'application/json' }), ...(opt.headers || {}) }, body: read ? undefined : JSON.stringify(opt.body) }); } catch {}
      const away = !r || r.status === 502 || r.status === 503 || r.status === 504;
      if (away) { lag(true); if (read && attempt < 3) { await wait(1200 * (attempt + 1)); continue; } const e = new Error('The node is catching up. Try again in a few seconds'); e.code = 503; throw e; }
      lag(r.headers.get('x-node') === 'catching-up');
      const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.code = r.status; throw e; } return j;
    }
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});

  // ---------- wallet ----------
  const W = { address: null, listeners: new Set() }, sol = () => window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null) || window.solana, evm = () => window.ethereum;
  const provider = () => (B.wallet === 'sol' ? sol() : evm());
  const changed = () => { for (const fn of W.listeners) { try { fn(W.address); } catch (e) { console.error(e); } } paintWallet(); };
  async function connect(silent) {
    const p = provider(); if (!p) { if (!silent) toast((B.wallet === 'sol' ? 'No Phantom wallet' : 'No wallet') + ' found in this browser. Install one, then come back.', 'bad'); return null; }
    try {
      if (B.wallet === 'sol') { const r = await p.connect(silent ? { onlyIfTrusted: true } : undefined); W.address = (r?.publicKey || p.publicKey).toString(); }
      else { const a = await p.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' }); W.address = a?.[0] ? a[0].toLowerCase() : null; }
    } catch (e) { if (!silent) toast('Wallet connection was cancelled.', 'bad'); W.address = null; }
    if (W.address) { try { localStorage.setItem('l2.wallet', '1'); } catch {} } changed(); return W.address;
  }
  function disconnect() { try { localStorage.removeItem('l2.wallet'); sessionStorage.removeItem('l2.auth'); } catch {} try { if (B.wallet === 'sol') sol()?.disconnect?.(); } catch {} W.address = null; changed(); }
  async function signText(text) {
    const p = provider();
    if (B.wallet === 'sol') { const r = await p.signMessage(new TextEncoder().encode(text), 'utf8'); return b58enc(r.signature || r); }
    return p.request({ method: 'personal_sign', params: ['0x' + hex(new TextEncoder().encode(text)), W.address] });
  }
  // One signature opens your private data for five minutes.
  async function auth() {
    if (!W.address) throw new Error('Connect your wallet first');
    try { const c = JSON.parse(sessionStorage.getItem('l2.auth') || 'null'); if (c && c.a === W.address && Date.now() - c.ts < 4.5 * 60_000) return c.h; } catch {}
    const ts = Date.now(), sig = await signText(B.tag + ' auth v1\n' + W.address + '\n' + ts), h = { 'x-l2-pubkey': W.address, 'x-l2-ts': String(ts), 'x-l2-sig': sig };
    try { sessionStorage.setItem('l2.auth', JSON.stringify({ a: W.address, ts, h })); } catch {} return h;
  }
  const hasAuth = () => { try { const c = JSON.parse(sessionStorage.getItem('l2.auth') || 'null'); return !!(c && c.a === W.address && Date.now() - c.ts < 4.5 * 60_000); } catch { return false; } };
  const mine = async (path) => api('/api/me/' + path, { headers: await auth() });
  async function sendTx(type, body) {
    if (!W.address && !(await connect())) throw new Error('Connect your wallet first');
    const { nonce } = await api('/api/nonce/' + W.address), unsigned = { chainId: B.chainId, from: W.address, nonce, type, body };
    let sig; try { sig = await signText(B.tag + ' tx v1\n' + canon(unsigned)); } catch { throw new Error('You declined the signature'); }
    const r = await api('/api/tx?wait=1', { body: { ...unsigned, sig } }); if (r.status === 'failed') throw new Error(r.error || 'Transaction failed'); return r;
  }
  // Deposit: a plain transfer on the settlement chain into the door, then tell the node which transaction to read.
  async function deposit(baseUnits) {
    const door = await api('/api/door'); if (!door.address) throw new Error('The door is not open yet');
    let l1;
    if (B.wallet === 'sol') {
      if (!door.blockhash) throw new Error('Solana did not answer. Try again');
      const u64 = new Uint8Array(8); let n = BigInt(baseUnits); for (let i = 0; i < 8; i++) { u64[i] = Number(n & 255n); n >>= 8n; }
      const parts = [Uint8Array.of(1, 0, 1, 3), b58dec(W.address), b58dec(door.address), new Uint8Array(32), b58dec(door.blockhash), Uint8Array.of(1, 2, 2, 0, 1, 12, 2, 0, 0, 0), u64], msg = new Uint8Array(parts.reduce((s, x) => s + x.length, 0)); let o = 0; for (const x of parts) { msg.set(x, o); o += x.length; }
      const r = await sol().request({ method: 'signAndSendTransaction', params: { message: b58enc(msg) } }); l1 = r.signature || r;
    } else {
      const want = '0x' + B.evmChainId.toString(16);
      try { await evm().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] }); } catch (e) { if (e?.code === 4902 && B.evmAdd) await evm().request({ method: 'wallet_addEthereumChain', params: [B.evmAdd] }); else throw e; }
      l1 = await evm().request({ method: 'eth_sendTransaction', params: [{ from: W.address, to: door.address, value: '0x' + BigInt(baseUnits).toString(16) }] });
    }
    return l1;
  }
  async function creditDeposit(l1, tries = 40) { for (let i = 0; i < tries; i++) { try { const r = await api('/api/deposit', { body: { l1 } }); if (r.status === 'credited' || r.status === 'known') return true; if (r.status === 'empty') return false; } catch {} await new Promise((ok) => setTimeout(ok, 2500)); } return false; }

  // ---------- toasts and copy ----------
  function toast(text, kind = '') { let box = $('#toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.append(box); } const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = text; box.append(t); setTimeout(() => t.classList.add('out'), 4200); setTimeout(() => t.remove(), 4700); }
  async function copy(text, label = 'Copied') { try { await navigator.clipboard.writeText(text); toast(label, 'good'); } catch { toast('Copy failed. Select the text and copy it by hand.', 'bad'); } }
  document.addEventListener('click', (e) => { const c = e.target.closest('[data-copy]'); if (c) { e.preventDefault(); copy(c.dataset.copy); } });

  // ---------- nav ----------
  const MARK = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><defs><radialGradient id="mk" cx="50%" cy="50%" r="50%"><stop offset="62%" stop-color="var(--c1)" stop-opacity="0"/><stop offset="74%" stop-color="var(--c1)"/><stop offset="100%" stop-color="var(--c2)" stop-opacity="0"/></radialGradient></defs><circle cx="16" cy="16" r="15" fill="url(#mk)"/><circle cx="16" cy="16" r="9.5" fill="#000"/><circle cx="16" cy="16" r="9.5" fill="none" stroke="var(--hot)" stroke-width=".9"/></svg>';
  function nav(active) {
    const el = document.createElement('header'); el.className = 'nav';
    el.innerHTML = `<a class="brand" href="/">${MARK}<span>${B.name}</span></a><nav>${[['Explorer', '/explorer'], ['Docs', '/docs'], ['Whitepaper', '/whitepaper'], ['Developers', '/developers']].map(([t, h]) => `<a href="${h}"${active === t ? ' class="on"' : ''}>${t}</a>`).join('')}${B.x ? `<a href="${B.x}" target="_blank" rel="noopener">X</a>` : ''}</nav>${active === 'App' ? '<button class="btn small" id="walletBtn"></button>' : '<a class="btn small" href="/app">Enter</a>'}`;
    document.body.prepend(el); if (active === 'App') { $('#walletBtn').onclick = () => (W.address ? disconnect() : connect()); paintWallet(); }
    addEventListener('scroll', () => el.classList.toggle('solid', scrollY > 30), { passive: true });
  }
  function paintWallet() { const b = $('#walletBtn'); if (!b) return; b.textContent = W.address ? short(W.address, 4, 4) : 'Connect wallet'; b.title = W.address ? 'Click to disconnect' : ''; }
  // Live head: one stream of blocks for whoever asks.
  let es; const blockFns = new Set();
  function onBlock(fn) { blockFns.add(fn); if (!es) { es = new EventSource('/api/stream'); es.addEventListener('block', (e) => { const b = JSON.parse(e.data); for (const f of blockFns) { try { f(b); } catch (x) { console.error(x); } } }); } }
  try { if (localStorage.getItem('l2.wallet')) addEventListener('load', () => connect(true)); } catch {}
  if (B.wallet === 'evm') window.ethereum?.on?.('accountsChanged', (a) => { W.address = a?.[0] ? a[0].toLowerCase() : null; try { sessionStorage.removeItem('l2.auth'); } catch {} changed(); });

  window.L2 = { B, $, $$, esc, units, parse, num, amount, usd, ago, short, int, COIN_DEC, api, W, connect, disconnect, auth, hasAuth, mine, sendTx, deposit, creditDeposit, toast, copy, nav, onBlock, sha256hex, MARK, onWallet: (fn) => W.listeners.add(fn) };
})();
