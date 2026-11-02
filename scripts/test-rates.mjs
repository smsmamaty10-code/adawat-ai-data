import { mergeRates, acceptRates } from './rates-lib.mjs';
const T = '2026-11-03', D = '2026-11-03', Y = '2026-11-02'; let fail = 0; const ok = (c, m) => { if (!c) { fail++; console.error('FAIL', m) } };
const prev = { base: 'USD', updated: Y, rates: { EGP: { rate: 50, date: Y, source: 'frankfurter' }, SDG: { rate: 450, date: Y, source: 'frankfurter' }, XYZ: { rate: 2, date: Y, source: 'open.er-api.com' }, TRY: { rate: 40, date: Y, source: 'frankfurter' } } };
let r = mergeRates(prev, { EGP: { rate: 54, date: D }, SDG: { rate: 600, date: D }, TRY: { rate: 50, date: D }, KWD: { rate: 0.31, date: D }, IRR: { rate: 1.8e6, date: D }, BTC: { rate: 0.00001, date: D } },
  { EGP: { rate: 54.2, date: D }, SDG: { rate: 460, date: D }, TRY: { rate: 50.5, date: D }, KWD: { rate: 0.3105, date: D }, IRR: { rate: 1.6e6, date: D }, ZWL: { rate: 322, date: D } }, T);
ok(r.rates.EGP.rate === 54 && r.rates.EGP.confirmed_by === 'open.er-api.com', '8% move accepted, confirmed');
ok(r.rates.SDG.rate === 450 && r.rates.SDG.date === Y && r.report.held.some(h => h.c === 'SDG'), '+33% not confirmed → held with old date');
ok(r.rates.TRY.rate === 50 && r.report.confirmed_big_moves.some(h => h.c === 'TRY'), '+25% confirmed within 2% → accepted');
ok(r.rates.XYZ && r.rates.XYZ.rate === 2, 'missing from sources → kept');
ok(r.rates.KWD && r.rates.KWD.source === 'frankfurter', 'new currency accepted');
ok(!r.rates.IRR && r.report.new_unconfirmed_skipped.some(h => h.c === 'IRR'), 'new currency with 12% disagreement → not published');
ok(!r.rates.BTC, 'crypto excluded'); ok(r.rates.ZWL && r.rates.ZWL.source === 'open.er-api.com', 'gap filled by er-api');
r = mergeRates(prev, { EGP: { rate: 70, date: D } }, null, T); ok(r.rates.EGP.rate === 50, '+40% single source → held');
r = mergeRates(prev, { EGP: { rate: 52, date: '2026-10-01' } }, null, T); ok(r.rates.EGP.rate === 50, 'stale source ignored');
r = mergeRates(prev, null, { EGP: { rate: 44, date: D } }, T); ok(r.rates.EGP.rate === 50, '-12% single source → held');
ok(acceptRates(prev, { base: 'USD', updated: T, rates: { EGP: { rate: 1, date: T, source: 'x' } } }).some(e => /removed/.test(e)), 'acceptance blocks deletion');
ok(acceptRates(prev, { base: 'USD', updated: T, rates: { ...prev.rates, EGP: { rate: -1, date: T, source: 'x' } } }).some(e => /bad rate/.test(e)), 'acceptance blocks bad rate');
console.log(fail ? `${fail} rate test(s) failed` : 'all rate tests passed'); process.exit(fail ? 1 : 0);
