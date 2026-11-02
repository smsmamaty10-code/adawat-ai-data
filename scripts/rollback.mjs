// Forward-dated rollback: restore price fields from an older data.json (a data-good-* tag) and stamp updated=today,
// because the app only accepts remote data whose max(updated) is >= what it already has (a plain git revert would be REJECTED on devices).
// Usage: node scripts/rollback.mjs --from tagged-data.json --data data.json [--tools id1,id2] [--out out]
import fs from 'fs'; import path from 'path';
const A = process.argv.slice(2); const arg = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d };
const FROM = JSON.parse(fs.readFileSync(arg('--from'), 'utf8')), FILE = arg('--data', 'data.json'), OUT = arg('--out', 'out');
const only = (arg('--tools', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const TODAY = process.env.TODAY || new Date().toISOString().slice(0, 10);
const FIELDS = ['price_usd', 'price_prev_usd', 'price_note', 'price_changed_on', 'price_check_method', 'price_monthly_computed', 'price_captured_on'];
const data = JSON.parse(fs.readFileSync(FILE, 'utf8')); const F = new Map(FROM.tools.map(t => [t.id, t]));
const rolled = [];
for (const t of data.tools) { const f = F.get(t.id); if (!f || (only.length && !only.includes(t.id))) continue;
  const diff = FIELDS.filter(k => JSON.stringify(t[k]) !== JSON.stringify(f[k])); if (!diff.length) continue;
  const before = t.price_usd;
  for (const k of diff) { if (k in f) t[k] = structuredClone(f[k]); else delete t[k] }   // only bot-written price fields are touched
  t.updated = TODAY; t.price_rollback_on = TODAY; rolled.push({ id: t.id, fields: diff, price: `${before} → ${t.price_usd}` }) }
if (only.length) for (const id of only) if (!rolled.some(r => r.id === id)) console.error(`note: ${id} has no price-field difference vs the tag`);
if (rolled.length) { data.built = TODAY; fs.writeFileSync(FILE, JSON.stringify(data)) }
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify({ mode: 'rollback', approved: rolled.map(r => r.id) }, null, 1));
fs.writeFileSync(path.join(OUT, 'rollback.json'), JSON.stringify(rolled, null, 1));
console.log(`rollback: ${rolled.length} tools restored with updated=${TODAY}` + (rolled.length ? '\n' + rolled.map(r => `- ${r.id}: ${r.price} [${r.fields.join(', ')}]`).join('\n') : ''));
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `count=${rolled.length}\n`);
