// CI gate: would the published Android app (v0.9.6, src/app.js) ACCEPT this data.json, and does it notify only for approved price drops?
// validTools / latest / remoteOk / MIN_RATIO / price-drop rule are copied verbatim (logic) from the app's src/app.js — keep in sync.
// Usage: node scripts/app-accept.mjs --old old.json --new data.json --plan plan.json   (exit 1 = do NOT push)
import fs from 'fs';
const num = v => typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v.trim() && isFinite(+v) ? +v : null);
export function validTools(list) { if (!Array.isArray(list)) return null; const seen = new Set(), out = [];
  for (const t of list) { if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id || seen.has(t.id)) continue; if (typeof t.name !== 'string' && typeof t.name_ar !== 'string') continue;
    const r = num(t.rating); if (r !== null && (r < 0 || r > 10)) continue; seen.add(t.id); out.push(t) } return out.length ? out : null }
export const MIN_RATIO = 0.9;
export function latest(ts) { return ts.map(t => t.updated).filter(d => typeof d === 'string').sort().pop() || null }
export function remoteOk(R, L) { const d = x => latest(x) || ''; const c = (T, k) => T.filter(t => t && t[k]).length; return d(R) >= d(L) && R.length >= L.length && c(R, 'play_store') >= c(L, 'play_store') && c(R, 'guide_ar') >= c(L, 'guide_ar') }
export function priceDrops(oldT, newT) { const O = new Map(oldT.map(t => [t.id, t])); const out = [];
  for (const t of newT) { const o = O.get(t.id); if (!o) continue; const a = num(o.price_usd), b = num(t.price_usd); if (a && b && b < a && b >= a * 0.3 && o.price_type === t.price_type) out.push(t.id) } return out }

const BOT_FIELDS = ['price_captured_on', 'price_check_method', 'price_monthly_computed', 'price_changed_on', 'price_prev_usd', 'price_usd', 'price_note', 'updated', 'price_rollback_on'];
// plan: {mode:'publish'|'rollback', approved:[ids allowed to change price], fixes:{id:[fields]}}
export function accept(oldData, newData, plan) {
  const errs = []; const mode = plan.mode || 'publish'; const approved = new Set(plan.approved || []); const fixes = plan.fixes || {};
  const L = validTools(oldData.tools) || [], R = validTools(newData.tools);
  if (!R) return ['new data: no valid tools'];
  if (R.length !== newData.tools.length) errs.push(`new data: ${newData.tools.length - R.length} tools fail app validation`);
  if (R.length < Math.ceil(L.length * MIN_RATIO)) errs.push('new data: shrink >10% (app would reject)');
  if (!remoteOk(R, L)) errs.push(`remoteOk=false (app would reject): updated ${latest(R)} vs ${latest(L)}, tools ${R.length} vs ${L.length}`);
  if (!newData.videos || typeof newData.videos !== 'object' || Array.isArray(newData.videos)) errs.push('videos not an object');
  if (newData.preview === true || R.some(t => 'review_pending' in t)) errs.push('preview data present');
  const N = new Map(R.map(t => [t.id, t]));
  for (const o of L) { const n = N.get(o.id); if (!n) { errs.push(`tool removed: ${o.id}`); continue }
    const allowed = new Set([...BOT_FIELDS, ...(fixes[o.id] || [])]);
    for (const k of Object.keys(o)) { if (!(k in n) && !(mode === 'rollback' && approved.has(o.id) && allowed.has(k))) errs.push(`${o.id}: field removed: ${k}`) }
    for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) { if (JSON.stringify(o[k]) === JSON.stringify(n[k])) continue;
      if (!allowed.has(k)) { errs.push(`${o.id}: non-price field changed: ${k}`); continue }
      if (['price_usd', 'price_prev_usd', 'price_note', 'price_changed_on'].includes(k) && !approved.has(o.id)) errs.push(`${o.id}: ${k} changed but tool not in approved list`);
      if (k === 'updated' && !approved.has(o.id)) errs.push(`${o.id}: updated changed by a plain verification (must only change on an approved change/rollback)`) } }
  for (const id of priceDrops(L, R)) if (!approved.has(id)) errs.push(`${id}: would trigger a price-drop notification but is not approved`);
  for (const id of approved) { const o = L.find(t => t.id === id), n = N.get(id); if (o && n && JSON.stringify(o.price_usd) !== JSON.stringify(n.price_usd) && n.updated <= (o.updated || '') && mode === 'publish') errs.push(`${id}: price changed without a newer updated date`) }
  return errs;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2); const arg = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null };
  const oldD = JSON.parse(fs.readFileSync(arg('--old'), 'utf8')), newD = JSON.parse(fs.readFileSync(arg('--new'), 'utf8')), plan = (() => { try { return JSON.parse(fs.readFileSync(arg('--plan'), 'utf8')) } catch { return {} } })();  // missing/empty plan ⇒ nothing approved
  const errs = accept(oldD, newD, plan);
  if (errs.length) { console.error('APP ACCEPTANCE FAILED — do not push:\n- ' + errs.slice(0, 50).join('\n- ')); process.exit(1) }
  console.log(`app acceptance OK: remoteOk=true, ${newD.tools.length} tools, price-drop notifications only for approved: [${priceDrops(oldD.tools, newD.tools).join(', ') || '-'}]`);
}
