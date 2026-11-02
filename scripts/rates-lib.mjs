// Exchange-rate merge rules (pure; unit-tested in scripts/test-rates.mjs). Rates are units of currency per 1 USD.
export const MAX_DAILY_MOVE = 0.10, AGREE = 0.02, MAX_SOURCE_AGE_DAYS = 10;
// crypto, precious metals and non-ISO codes are not currencies a user pays in
const EXCLUDE = new Set(['BTC', 'BCH', 'ETH', 'LTC', 'XRP', 'XAG', 'XAU', 'XPD', 'XPT', 'XDR', 'CMD']);
export const isCurrency = c => /^[A-Z]{3}$/.test(c) && !EXCLUDE.has(c);
const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 864e5;
const okRate = r => typeof r === 'number' && isFinite(r) && r > 0;
export const sig = r => +r.toPrecision(6);
// prev: previous rates.json (or null). primary: {CODE:{rate,date}} from Frankfurter. second: {CODE:{rate,date}} from open.er-api.com.
export function mergeRates(prev, primary, second, today) {
  const P = (prev && prev.rates) || {}, out = {}, report = { accepted: [], confirmed_big_moves: [], held: [], new_unconfirmed_skipped: [], kept_missing: [], stale_source: [] };
  const fresh = x => x && okRate(x.rate) && typeof x.date === 'string' && days(x.date, today) <= MAX_SOURCE_AGE_DAYS;
  const codes = new Set([...Object.keys(P), ...Object.keys(primary || {}), ...Object.keys(second || {})].filter(isCurrency));
  codes.delete('USD');
  for (const c of [...codes].sort()) {
    const f = fresh(primary?.[c]) ? primary[c] : null, e = fresh(second?.[c]) ? second[c] : null, old = P[c];
    if (!f && primary?.[c] && !e) report.stale_source.push(c);
    const cand = f ? { rate: sig(f.rate), date: f.date, source: 'frankfurter' } : e ? { rate: sig(e.rate), date: e.date, source: 'open.er-api.com' } : null;
    const agree = !!(f && e && Math.abs(f.rate / e.rate - 1) <= AGREE);
    if (!cand) { if (old) { out[c] = old; report.kept_missing.push(c) } continue }   // never delete: keep the last good rate with its date
    if (cand.date && old?.date && cand.date < old.date) { out[c] = old; continue }       // never go back in time
    if (f && e) cand.confirmed_by = agree ? 'open.er-api.com' : null;
    if (!cand.confirmed_by) delete cand.confirmed_by;
    if (!old) {
      // first time we see this currency: if both sources exist they must not disagree by more than 10%, otherwise publish nothing for it
      if (f && e && Math.abs(f.rate / e.rate - 1) > MAX_DAILY_MOVE) { report.new_unconfirmed_skipped.push({ c, frankfurter: f.rate, er: e.rate }); continue }
      out[c] = cand; report.accepted.push(c); continue }
    const move = cand.rate / old.rate - 1;
    if (Math.abs(move) <= MAX_DAILY_MOVE) { out[c] = cand; report.accepted.push(c); continue }
    if (agree) { out[c] = cand; report.confirmed_big_moves.push({ c, from: old.rate, to: cand.rate, pct: +(move * 100).toFixed(1) }); continue }
    out[c] = old; report.held.push({ c, kept: old.rate, kept_date: old.date, seen: cand.rate, pct: +(move * 100).toFixed(1), frankfurter: f?.rate ?? null, er: e?.rate ?? null });
  }
  return { rates: out, report };
}
// structural acceptance before writing/pushing (mirrors what the app accepts in validRates())
export function acceptRates(prev, next) {
  const errs = [];
  if (!next || next.base !== 'USD' || typeof next.updated !== 'string' || !next.rates || typeof next.rates !== 'object') return ['bad shape'];
  for (const [c, v] of Object.entries(next.rates)) {
    if (!isCurrency(c)) errs.push(`${c}: not a currency code`);
    if (!v || !okRate(v.rate)) errs.push(`${c}: bad rate`);
    if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) errs.push(`${c}: bad date`);
    if (!v || typeof v.source !== 'string') errs.push(`${c}: no source`);
  }
  if (prev?.rates) for (const c of Object.keys(prev.rates)) if (!next.rates[c]) errs.push(`${c}: removed (never delete)`);
  if (prev?.updated && next.updated < prev.updated) errs.push('updated went backwards');
  return errs;
}
