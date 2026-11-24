// The door and the seal: credits deposits, pays withdrawals exactly once, and writes block receipts
// to the settlement chain. Bookkeeping for payouts lives outside chain state in S.bridge.
export function startBridge(chain, { dev = false } = {}) {
  const A = chain.A, S = chain.S, errors = { deposit: null, payout: null, seal: null };
  S.bridge ||= {};
  const guard = (name, fn) => { let busy = false; return async () => { if (busy) return; busy = true; try { await fn(); errors[name] = null; } catch (e) { errors[name] = String(e?.message || e).slice(0, 200); } finally { busy = false; } }; };

  async function credit(l1) {
    if (S.deposits[l1]) return 'known';
    const d = await A.deposit(l1); if (!d) return 'pending';
    S.deposits[l1] = 1; chain.touch();
    if (d.amount > 0n && A.isAddress(d.from)) { chain.system('sys.deposit', { to: A.norm(d.from), amount: String(d.amount), l1 }); return 'credited'; }
    return 'empty';
  }
  const deposits = guard('deposit', async () => { if (!A.door || !A.scan) return; const r = await A.scan(S.doorCursor), list = Array.isArray(r) ? r : r.ids; for (const l1 of list) { await credit(l1); if (Array.isArray(r)) { S.doorCursor = l1; chain.touch(); } } if (!Array.isArray(r) && r.cursor !== S.doorCursor) { S.doorCursor = r.cursor; chain.touch(); } });

  // Exactly once: the settlement transaction is signed and saved before it is broadcast. A retry checks that saved transaction first.
  const payouts = guard('payout', async () => {
    if (!A.canPay) return;
    for (const w of Object.values(S.withdrawals)) {
      if (w.kind !== 'withdraw' || w.status !== 'queued') continue;
      const b = (S.bridge[w.id] ||= { step: 'new' });
      if (b.step === 'settling') continue;
      if (b.step === 'new') { const p = await A.preparePayout(w.to, w.amount, w); Object.assign(b, { step: 'signed', l1: p.l1, raw: p.raw, expiry: p.expiry, tries: (b.tries || 0) + 1 }); chain.touch(); chain.save(); await A.broadcast(p.raw).catch(() => {}); continue; }
      const st = await A.status(b.l1, b.expiry, w);
      if (st === 'confirmed') { b.step = 'settling'; delete b.raw; chain.system('sys.payout', { id: w.id, l1: b.l1 }); }
      else if (st === 'failed' || (st === 'expired' && b.tries >= 5)) { b.step = 'settling'; delete b.raw; chain.system('sys.refund', { id: w.id, reason: 'payout could not be completed' }); }
      else if (st === 'expired') { b.step = 'new'; chain.touch(); }
      else await A.broadcast(b.raw).catch(() => {});
    }
  });

  // If the settlement chain already holds a receipt this node never recorded (it stopped between sending and saving), adopt it before writing more.
  const seal = guard('seal', async () => {
    if (dev && !A.canSeal) return chain.seal(async (r) => 'dev-' + r.checkpoint.slice(0, 40));
    const ahead = A.sealedTo ? (await A.sealedTo()) - S.sealed.to : 0;
    if (ahead > 0 && S.sealed.count) return chain.seal(async (r) => { if (r.checkpoint !== await A.sealedCheckpoint()) throw new Error('the settlement contract holds a different checkpoint'); return (await A.findReceipt(r.to)) || 'recorded'; }, ahead);
    return chain.seal((r, prev) => A.writeReceipt(r, prev));
  });
  if (A.canSeal || dev) chain.enableSealing();

  const timers = [setInterval(deposits, 20_000), setInterval(payouts, 5_000), setInterval(seal, chain.RULES.receiptMs)];
  for (const t of timers) t.unref?.();
  return { credit, errors, tick: { deposits, payouts, seal }, stop: () => timers.forEach(clearInterval) };
}
