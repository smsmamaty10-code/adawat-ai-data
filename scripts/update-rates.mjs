// Daily exchange rates → rates.json (units per 1 USD). Free, no keys: Frankfurter (primary; ECB + other central banks),
// open.er-api.com (second source / fills gaps). Safety: a >10% daily move is rejected unless both sources agree within 2%;
// otherwise the last good rate is kept with its own date. Currencies are never deleted.
// Usage: node scripts/update-rates.mjs [--file rates.json] [--out out]
import fs from 'fs'; import path from 'path';
import { mergeRates, acceptRates, isCurrency } from './rates-lib.mjs';
const A = process.argv.slice(2); const arg = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d };
const FILE = arg('--file', 'rates.json'), OUT = arg('--out', 'out'), TODAY = process.env.TODAY || new Date().toISOString().slice(0, 10);
const getJSON = async (u) => { for (let i = 0; i < 3; i++) { try { const r = await fetch(u, { signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'adawat-ai-data rates bot (GitHub Actions)' } }); if (r.ok) return await r.json(); } catch { } await new Promise(r => setTimeout(r, 3000)) } return null };
const prev = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null;
let primary = null, second = null;
const fv2 = await getJSON('https://api.frankfurter.dev/v2/rates?base=USD');
if (Array.isArray(fv2)) { primary = {}; for (const x of fv2) if (x && isCurrency(x.quote)) primary[x.quote] = { rate: x.rate, date: x.date } }
else { const v1 = await getJSON('https://api.frankfurter.dev/v1/latest?base=USD'); if (v1?.rates) { primary = {}; for (const [c, r] of Object.entries(v1.rates)) primary[c] = { rate: r, date: v1.date } } }
const er = await getJSON('https://open.er-api.com/v6/latest/USD');
if (er?.result === 'success' && er.rates) { const d = new Date(er.time_last_update_unix * 1000).toISOString().slice(0, 10); second = {}; for (const [c, r] of Object.entries(er.rates)) second[c] = { rate: r, date: d } }
if (!primary && !second) { console.error('no rate source reachable — rates.json left unchanged'); process.exit(1) }
const { rates, report } = mergeRates(prev, primary, second, TODAY);
const next = { base: 'USD', updated: TODAY, note: 'Units per 1 USD. Estimates for display only; official prices are in USD on each company site.',
  sources: { frankfurter: 'https://frankfurter.dev (ECB and other central banks, free, no key)', 'open.er-api.com': 'https://www.exchangerate-api.com (free open access, no key)' },
  rules: 'A >10% daily move is rejected unless both sources agree within 2%; then the last good rate is kept with its own date. Never deleted.',
  rates };
const errs = acceptRates(prev, next);
fs.mkdirSync(OUT, { recursive: true });
const md = [`# Exchange rates ${TODAY}`, '', `Sources: Frankfurter ${primary ? Object.keys(primary).length : 'DOWN'} · open.er-api.com ${second ? Object.keys(second).length : 'DOWN'} → **${Object.keys(rates).length} currencies** in rates.json`,
  `Updated today: ${report.accepted.length} · big moves confirmed by both sources: ${report.confirmed_big_moves.length} · **held (kept last good rate): ${report.held.length}** · new but sources disagree >10% (not published): ${report.new_unconfirmed_skipped.length} · missing from sources (kept): ${report.kept_missing.length}`,
  ...report.held.map(h => `- HELD ${h.c}: kept ${h.kept} (${h.kept_date}), seen ${h.seen} (${h.pct}%), frankfurter=${h.frankfurter} er=${h.er}`),
  ...report.confirmed_big_moves.map(h => `- CONFIRMED MOVE ${h.c}: ${h.from} → ${h.to} (${h.pct}%)`),
  ...report.new_unconfirmed_skipped.map(h => `- SKIPPED NEW ${h.c}: frankfurter=${h.frankfurter} er=${h.er}`),
  errs.length ? `\n**ACCEPTANCE FAILED — rates.json not written:**\n${errs.map(e => '- ' + e).join('\n')}` : '\nAcceptance: ✅ OK', ''].join('\n');
fs.writeFileSync(path.join(OUT, 'rates-report.md'), md); fs.writeFileSync(path.join(OUT, 'rates-report.json'), JSON.stringify(report, null, 1));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
console.log(md);
if (errs.length) process.exit(1);
// pretty, one currency per line → readable diffs
const body = JSON.stringify({ ...next, rates: {} }, null, 1).replace(/"rates": \{\}/, '"rates": {\n' + Object.entries(rates).map(([c, v]) => `  ${JSON.stringify(c)}: ${JSON.stringify(v)}`).join(',\n') + '\n }');
JSON.parse(body); fs.writeFileSync(FILE, body + '\n');
