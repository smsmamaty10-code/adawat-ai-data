// Weekly conservative price checker for data.json. No secrets, no AI, plain HTTP only (Node 20+ fetch).
// Rules (see also change conditions below): monthly USD prices are read from the official pricing page (tool.source / price_url).
//  - confirmed: old price_usd appears as a monthly USD price on the page → price_captured_on/updated = today
//  - changed:   old price not found, exactly ONE distinct monthly USD candidate, within 0.5x..2x of old → update
//  - anything else (ambiguous / not found / fetch failed / JS-only page) → unchanged, dates untouched
import fs from 'fs';
const FILE = process.argv[2] || 'data.json';
const TODAY = new Date().toISOString().slice(0, 10);
const old = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const data = structuredClone(old);
const UA = 'Mozilla/5.0 (compatible; adawat-ai-price-check/1.0; +https://github.com/smsmamaty10-code/adawat-ai-data)';
const num = v => typeof v === 'number' && isFinite(v) ? v : null;

async function get(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8' } });
    if (!r.ok) return null; const s = await r.text(); return s.length > 500 ? s : null; } catch { return null } finally { clearTimeout(t) }
}
function text(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;|&dollar;/g, '$').replace(/\s+/g, ' ');
}
// "$20/month", "$20 per month", "$20 / mo", "$20 USD/month", "US$20 per user/month" (no yearly/annual billed totals)
const RE = /(?:US)?\$\s?(\d{1,4}(?:\.\d{1,2})?)\s*(?:USD)?\s*(?:\/|per|a)\s*(?:user\s*\/?\s*|seat\s*\/?\s*|member\s*\/?\s*)?(?:mo\b|month)/gi;
function monthly(t) { const out = new Map(); for (const m of t.matchAll(RE)) { const v = +m[1]; if (!(v > 0 && v < 5000)) continue;
  const ctx = t.slice(Math.max(0, m.index - 100), m.index + m[0].length + 100); const annual = /annual|yearly|\/\s*year|per year|billed/i.test(ctx);
  out.set(v, (out.get(v) || false) || annual) } return [...out].map(([v, annual]) => ({ v, annual })) }
const same = (a, b) => Math.abs(a - b) < 0.006;


// ---- conservative offer detection: «N% off» / «discount N%» / «save N%» within 80 chars of a $ price,
// plus promo wording (first month / new user / limited time / offer / sale / promo / coupon…), NOT annual-billing/API/lifetime wording (that's a standard discount). Auto offers are refreshed each run; kept ≤14 days if page unreadable.
const OFF_RE = /(\d{1,2})\s?%\s?off\b|\b(?:discount|save)\s(?:of\s)?(\d{1,2})\s?%/gi;
function offers(t) { const out = []; for (const m of t.matchAll(OFF_RE)) { const pc = +(m[1] || m[2]); if (pc < 5 || pc > 90) continue;
  const ctx = t.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80); if (!/\$\s?\d/.test(ctx) || /annual|yearly|\/\s*year|per year|billed|year|lifetime|batch|mtok|api\b|per credit|proofread/i.test(ctx)) continue;
  if (!/first month|new user|limited[- ]time|offer|sale\b|promo|black friday|cyber monday|launch|ends|today only|coupon/i.test(ctx)) continue; // must look like a real promotion
  out.push({ pc, quote: ctx.trim().slice(0, 200) }) } return out }
const daysAgo = d => (Date.parse(TODAY) - Date.parse(d)) / 864e5;
function setAutoOffers(t, found, url) { const keep = (t.offers || []).filter(o => !o.auto); const prevAuto = (t.offers || []).filter(o => o.auto);
  let auto; if (found === null) auto = prevAuto.filter(o => daysAgo(o.captured_on) <= 14);
  else { const pcs = [...new Set(found.map(f => f.pc))]; auto = pcs.length === 1 ? [{ auto: true, text_ar: `خصم ${pcs[0]}%${/first month/i.test(found[0].quote) ? ' على الشهر الأول' : ''}${/new user/i.test(found[0].quote) ? ' للمستخدمين الجدد' : ''} مرصود في صفحة الأسعار الرسمية`, quote_en: found[0].quote, source: url, captured_on: TODAY, ends_on: null }] : [] }
  const all = [...keep, ...auto]; if (all.length) t.offers = all; else delete t.offers; if (auto.length) stats.offers++ }
const stats = { total: data.tools.length, confirmed: 0, changed: 0, unchanged: 0, unreadable: 0, skipped: 0, offers: 0 }; const ex = { confirmed: [], changed: [], unchanged: [], unreadable: [] };
const tasks = data.tools.map(t => async () => {
  const p = num(t.price_usd); const url = [t.price_url, t.source].find(u => typeof u === 'string' && /^https?:\/\//.test(u));
  if (!p || p <= 0 || t.price_type !== 'ثابت' || !url) { stats.skipped++; return }
  const html = await get(url); setAutoOffers(t, html ? offers(text(html)) : null, url); if (!html) { stats.unreadable++; ex.unreadable.push(t.id); return }
  const cc = monthly(text(html)); const c = cc.map(x => x.v);
  if (!c.length) { stats.unreadable++; ex.unreadable.push(t.id); return }
  if (c.some(v => same(v, p))) { t.price_captured_on = TODAY; t.updated = TODAY; stats.confirmed++; ex.confirmed.push(`${t.id} $${p}`); return }
  // change only: single candidate, no annual/billed wording nearby, USD-native price (not approx/converted), value not already in note (other plan/period)
  const noteHas = v => new RegExp(`(^|[^\\d.])${String(v).replace('.', '\\.')}(?![\\d])`).test(String(t.price_note || ''));
  if (c.length === 1 && !cc[0].annual && !t.price_approx && !t.price_orig && !noteHas(c[0]) && c[0] >= p * 0.5 && c[0] <= p * 2) {
    const n = c[0]; t.price_prev_usd = p; t.price_usd = n;
    if (typeof t.price_note === 'string') t.price_note = t.price_note.replace(new RegExp(`(^|[^\\d.])${String(p).replace('.', '\\.')}(?=\\s?\\$)`, 'g'), `$1${n}`).replace(new RegExp(`\\$\\s?${String(p).replace('.', '\\.')}(?![\\d.])`, 'g'), `$${n}`);
    t.price_captured_on = TODAY; t.updated = TODAY; stats.changed++; ex.changed.push(`${t.id} $${p}→$${n}`); return
  }
  stats.unchanged++; ex.unchanged.push(`${t.id} (old $${p}; page: ${c.slice(0, 6).join(',')})`);
});
// small concurrency
const q = [...tasks]; await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) await q.shift()() }));

// ---- safety checks (same spirit as publish-data.sh) ----
const seen = new Set();
const ok = data.tools.filter(t => { if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id || seen.has(t.id)) return false;
  if (typeof t.name !== 'string' && typeof t.name_ar !== 'string') return false; const r = typeof t.rating === 'number' ? t.rating : null; if (r !== null && (r < 0 || r > 10)) return false; seen.add(t.id); return true });
const fail = m => { console.error('ABORT: ' + m); process.exit(1) };
if (ok.length !== data.tools.length) fail('tools fail validation');
if (ok.length < Math.ceil(old.tools.length * 0.9)) fail('tool count guard');
if (!data.videos || typeof data.videos !== 'object' || Array.isArray(data.videos)) fail('videos not an object');
if (data.preview === true || data.tools.some(t => 'review_pending' in t)) fail('preview data present');

const changed = JSON.stringify(data.tools) !== JSON.stringify(old.tools);
if (changed) { data.built = TODAY; fs.writeFileSync(FILE, JSON.stringify(data)) }
const summary = `offers detected: ${stats.offers}; prices: ${stats.confirmed} confirmed, ${stats.changed} updated, ${stats.unchanged} unchanged (ambiguous), ${stats.unreadable} unreadable, ${stats.skipped} skipped (free/usage/no price) of ${stats.total}`;
console.log(summary); for (const k of Object.keys(ex)) console.log(k + ':', ex[k].join(' | ') || '-');
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\nsummary=${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n\n' + Object.entries(ex).map(([k, v]) => `**${k}**: ${v.join(', ') || '-'}`).join('\n\n') + '\n');
