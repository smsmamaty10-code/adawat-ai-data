// Daily conservative price checker for data.json — no secrets, no AI, no personal keys (only public HTTP + optional free Playwright + Wayback).
// SAFETY MODEL (see README):
//   • confirm   : the stored monthly USD price is found on an official page → only price_captured_on (= «آخر تأكيد للسعر») moves. `updated` does NOT.
//   • change ≤15%      : same unique value on 2 consecutive days → approved.
//   • change 15–50%    : needs 2 independent official URLs agreeing AND 2 consecutive days, otherwise held.
//   • change >50% or any drop >30% : always held (the app pushes a «price dropped» notification to every user).
//   • more than N (5) proposed changes in one run → publish NOTHING (circuit breaker).
//   • Wayback is used ONLY to confirm an unchanged price, never to change one. Annual÷12 confirmations are flagged as computed.
//   • never deletes a value; held/failed tools keep their last good value and last-verified date.
//   • DRY_RUN (default true): data.json is never written; only out/ report files are produced.
// Usage: node scripts/update-prices.mjs [--data data.json] [--config scripts/price-config.json] [--state prev-state/state.json] [--out out]
import fs from 'fs'; import path from 'path';
import { htmlToText, evaluate, isChallenge, same, nonUsdMarks } from './price-lib.mjs';
import { accept } from './app-accept.mjs';
import { normalizeList, matchValue } from './us-check-lib.mjs';

const A = process.argv.slice(2); const arg = (k, d) => { const i = A.indexOf(k); return i >= 0 ? A[i + 1] : d };
const FILE = arg('--data', 'data.json'), CFG = JSON.parse(fs.readFileSync(arg('--config', 'scripts/price-config.json'), 'utf8'));
const OUT = arg('--out', 'out'); fs.mkdirSync(OUT, { recursive: true });
const DRY = process.env.DRY_RUN !== 'false';                       // dry unless explicitly "false"
const RENDER = process.env.RENDER !== '0', WAYBACK = process.env.WAYBACK !== '0';
const TODAY = process.env.TODAY || new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.parse(TODAY) - 864e5).toISOString().slice(0, 10);
const MAX_CHANGES = +(process.env.MAX_CHANGES || CFG.max_changes_per_run || 5), WB_AGE = CFG.wayback_max_age_days || 14;
const old = JSON.parse(fs.readFileSync(FILE, 'utf8')); const data = structuredClone(old);
let prevState = { pending: {}, held: {} }; try { const s = arg('--state'); if (s && fs.existsSync(s)) prevState = { pending: {}, held: {}, ...JSON.parse(fs.readFileSync(s, 'utf8')) } } catch { }
const UA = 'Mozilla/5.0 (compatible; adawat-ai-price-check/2.0; +https://github.com/smsmamaty10-code/adawat-ai-data)';
const num = v => typeof v === 'number' && isFinite(v) ? v : null;
const log = (...x) => console.error(...x);

// Reference price = the US price in USD. Every request asks for the US/English page; per-tool overrides in config.fetch_profile.
const DEFAULT_PROFILE = { locale: 'en-US', timezone: 'America/New_York', accept_language: 'en-US,en;q=0.9' };
const profileOf = id => ({ ...DEFAULT_PROFILE, ...(CFG.fetch_profile?.[id] || {}) });
async function staticFetch(url, prof = DEFAULT_PROFILE) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8', 'accept-language': prof.accept_language } });
    const html = await r.text(); return { status: r.status, html, challenge: isChallenge(r.status, html), ok: r.ok && html.length > 500 } }
  catch (e) { return { status: 0, html: '', error: String(e && e.name || e), ok: false } } finally { clearTimeout(tm) }
}
// ---- optional Playwright (free, runs inside the CI runner). No stealth plugins, no CAPTCHA solving: if a page challenges us we give up.
let browserP = null;
async function browser() { if (!RENDER) return null; if (!browserP) browserP = (async () => { try { const pw = await import(process.env.PW_MODULE || 'playwright'); return await pw.chromium.launch({ headless: true }) } catch (e) { log('playwright unavailable:', e.message); return null } })(); return browserP }
let renderSlots = 3; const waiters = [];
async function render(url, clicks = [], prof = DEFAULT_PROFILE) {
  const b = await browser(); if (!b) return null;
  if (renderSlots <= 0) await new Promise(r => waiters.push(r)); renderSlots--;
  const ctx = await b.newContext({ locale: prof.locale, timezoneId: prof.timezone, extraHTTPHeaders: { 'accept-language': prof.accept_language }, viewport: { width: 1366, height: 900 } }); const page = await ctx.newPage();
  try { const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => { });
    await page.waitForTimeout(1500);
    for (const label of clicks) { try { await page.getByText(label, { exact: true }).first().click({ timeout: 4000 }); await page.waitForTimeout(1200) } catch { } } // e.g. a plan-audience tab (config.render_clicks)
    const html = await page.content(); const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    const status = resp ? resp.status() : 0; return { status, html, text: text.replace(/\s+/g, ' '), challenge: isChallenge(status, html) || /^Just a moment/i.test(await page.title()) }
  } catch (e) { return { status: 0, html: '', text: '', error: e.message.slice(0, 80) } }
  finally { await ctx.close().catch(() => { }); renderSlots++; const w = waiters.shift(); if (w) w() }
}
// ---- Wayback (archive.org, no key): CONFIRM-ONLY second source, snapshot must be ≤ WB_AGE days old.
let wbChain = Promise.resolve();                                   // serialise archive.org calls (it rate-limits with 429)
const wbSlot = () => { const p = wbChain.then(() => new Promise(r => setTimeout(r, 1500))); wbChain = p; return p };
async function wayback(url) {
  try { await wbSlot();
    const from = new Date(Date.parse(TODAY) - WB_AGE * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
    const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url.replace(/^https?:\/\//, ''))}&output=json&filter=statuscode:200&from=${from}&limit=-1`;
    let r; for (let k = 0; k < 2; k++) { const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 25000);
      r = await fetch(cdx, { signal: ctl.signal, headers: { 'user-agent': UA } }).catch(() => null); clearTimeout(tm); if (r && r.status !== 429) break; await new Promise(z => setTimeout(z, 5000)) }
    if (!r || !r.ok) return null; const rows = await r.json().catch(() => null); if (!Array.isArray(rows) || rows.length < 2) return null;
    const [, ts, original] = rows[rows.length - 1]; const date = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
    const age = (Date.parse(TODAY) - Date.parse(date)) / 864e5; if (age > WB_AGE || age < 0) return { date, tooOld: true };
    await wbSlot(); const f = await staticFetch(`https://web.archive.org/web/${ts}id_/${original}`);
    return f.ok ? { date, html: f.html, snapshot: `https://web.archive.org/web/${ts}/${original}` } : null
  } catch { return null }
}
const host = u => { try { return new URL(u).hostname.replace(/^www\./, '').split('.').slice(-2).join('.') } catch { return '' } };
const isConverted = t => !!(t.price_orig || t.price_orig_currency || /محوَّل|محول|بسعر صرف/.test(String(t.price_note || '')));
const noteHas = (t, v) => new RegExp(`(^|[^\\d.])${String(v).replace('.', '\\.')}(?![\\d])`).test(String(t.price_note || ''));

// what the runner actually saw on each live page (for the US-vs-stored price diff report)
const seenOf = pages => pages.map(x => ({ url: x.url, via: x.via, monthly: x.ev.monthly.slice(0, 10), yearly: x.ev.yearly.slice(0, 6), dollars: (x.ev.dollars || []).slice(0, 15), snips: (x.ev.snips || []).slice(0, 4), non_usd: x.ev.nonUsd || [] }));
async function checkTool(t) {
  const p = num(t.price_usd); const primary = CFG.price_url?.[t.id] || [t.price_url, t.source].find(u => typeof u === 'string' && /^https?:\/\//.test(u));
  const r = { id: t.id, name: t.name, price: p, url: primary || null };
  if (!p || p <= 0 || t.price_type !== 'ثابت' || !primary) return { ...r, status: 'skipped', cause: t.price_type === 'مجاني بالكامل' || p === 0 ? 'free' : t.price_type === 'حسب الاستخدام' ? 'usage-based' : 'no-price' };
  if (isConverted(t)) return { ...r, status: 'manual', cause: 'converted-currency' };
  const urls = [...new Set([primary, ...(CFG.extra_sources?.[t.id] || []), ...(typeof t.price_yearly_source === 'string' && host(t.price_yearly_source) === host(primary) ? [t.price_yearly_source] : [])])];
  const pages = []; const fetchInfo = []; const prof = profileOf(t.id);
  for (const url of urls) { const f = await staticFetch(url, prof); fetchInfo.push({ url, via: 'static', status: f.status, challenge: !!f.challenge, error: f.error });
    if (f.ok && !f.challenge) { const ev = evaluate(p, num(t.price_yearly_usd), f.html, htmlToText(f.html)); pages.push({ url, via: 'static', ev }); if (ev.confirm) break } }
  let conf = pages.find(x => x.ev.confirm);
  if (!conf && RENDER) for (const url of urls) { const g = await render(url, CFG.render_clicks?.[t.id] || [], prof); if (!g) break; fetchInfo.push({ url, via: 'rendered', status: g.status, challenge: !!g.challenge, error: g.error });
    if (g.text && g.text.length > 200 && !g.challenge) { const ev = evaluate(p, num(t.price_yearly_usd), g.html, g.text); pages.push({ url, via: 'rendered', ev }); if (ev.confirm) { conf = pages.at(-1); break } } }
  if (conf) return { ...r, status: 'confirmed', method: conf.ev.confirm.method, computed: !!conf.ev.confirm.computed, via: conf.via, source: conf.url, quote: conf.ev.confirm.ctx.slice(0, 220) };
  // ---- change proposal: every readable page must offer exactly ONE strict monthly value, the same one, not mentioned in the note as another plan
  const perUrl = [...new Map(pages.map(x => [x.url, x])).values()];           // rendered result (pushed later) wins over static for the same URL
  const singles = perUrl.map(x => x.ev.strict.length === 1 ? x.ev.strict[0] : null);
  const vals = [...new Set(singles.filter(v => v != null))];
  if (perUrl.length && !singles.includes(null) && vals.length === 1 && !noteHas(t, vals[0])) {
    const n = vals[0]; const srcUrls = perUrl.map(x => x.url);
    return { ...r, status: 'proposal', proposed: n, sources: srcUrls, pages: pages.map(x => ({ url: x.url, via: x.via, monthly: x.ev.monthly })) };
  }
  // ---- Wayback: confirm-only
  if (WAYBACK) { const w = await wayback(primary); if (w && w.html) { const ev = evaluate(p, num(t.price_yearly_usd), w.html, htmlToText(w.html));
      if (ev.confirm) return { ...r, status: 'confirmed', live_seen: seenOf(pages), method: 'wayback+' + ev.confirm.method, computed: !!ev.confirm.computed, via: 'wayback', source: w.snapshot, snapshot_date: w.date, quote: ev.confirm.ctx.slice(0, 220) } }
    r.wayback = w ? (w.tooOld ? `snapshot too old (${w.date})` : `snapshot ${w.date}: price not found`) : 'no snapshot' }
  // ---- classify failure
  const anyBlocked = fetchInfo.some(f => f.challenge || [401, 403, 429, 503].includes(f.status)), anyRead = pages.length > 0;
  const monthly = [...new Set(pages.flatMap(x => x.ev.monthly))], yearly = [...new Set(pages.flatMap(x => x.ev.yearly))];
  let cause;
  if (!anyRead) cause = anyBlocked ? 'blocked-403/challenge' : fetchInfo.some(f => f.status === 404) ? 'http-404' : 'fetch-failed';
  else if (monthly.length) cause = 'ambiguous (stored price not on page; several/other values)';
  else if (yearly.length) cause = 'annual-only (no matching annual÷12)';
  else if (pages.every(x => x.ev.dollarCount === 0)) cause = RENDER ? 'no-$-price-even-rendered (JS/geo/blocked)' : 'js-rendered (no $ in static HTML)';
  else cause = 'no-monthly-price-format';
  return { ...r, status: 'unconfirmed', cause, monthly: monthly.slice(0, 8), yearly: yearly.slice(0, 5), fetch: fetchInfo, seen: seenOf(pages) };
}

// ---- run (small concurrency)
const results = []; const q = [...data.tools];
await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) { const t = q.shift(); try { results.push(await checkTool(t)) } catch (e) { results.push({ id: t.id, status: 'unconfirmed', cause: 'error: ' + e.message }) } } }));
// ---- US check list (REPORT-ONLY): compare every listed value against the US pages; never touches data.json
const US_LIST = arg('--us-check', 'us-check-list.json'); let usCheck = { list: US_LIST, present: false, items: [] };
if (fs.existsSync(US_LIST)) { try {
  const items = normalizeList(JSON.parse(fs.readFileSync(US_LIST, 'utf8'))); usCheck.present = true;
  const toolsById = new Map(old.tools.map(t => [t.id, t]));
  const checkItem = async it => { const t = toolsById.get(it.id) || {}; const prof = profileOf(it.id);
    const urls = it.urls.length ? it.urls : [CFG.price_url?.[it.id] || t.price_url || t.source].filter(u => typeof u === 'string' && /^https?:\/\//.test(u));
    const pages = [], fetch = [];
    for (const url of urls) { const f = await staticFetch(url, prof); fetch.push({ url, via: 'static', status: f.status, challenge: !!f.challenge });
      if (f.ok && !f.challenge) pages.push({ url, via: 'static', html: f.html, text: htmlToText(f.html) }) }
    const tryAll = () => it.values.map(v => { for (const pg of pages) { const m = matchValue(v.value, v.period, pg.html, pg.text); if (m.match) return { ...v, ...m, url: pg.url, via: pg.via } }
      const near = pages.map(pg => ({ pg, m: matchValue(v.value, v.period, pg.html, pg.text) })).find(x => x.m.method);
      return { ...v, match: false, method: near?.m.method || null, ctx: near?.m.ctx || '', url: near?.pg.url || null } });
    let vals = tryAll();
    if (RENDER && vals.some(v => !v.match)) for (const url of urls) { const g = await render(url, CFG.render_clicks?.[it.id] || [], prof); if (!g) break;
      fetch.push({ url, via: 'rendered', status: g.status, challenge: !!g.challenge, error: g.error }); if (g.text && g.text.length > 200 && !g.challenge) pages.push({ url, via: 'rendered', html: g.html, text: g.text }) }
    if (pages.some(p => p.via === 'rendered')) vals = tryAll();
    const non_usd = [...new Set(pages.flatMap(p => nonUsdMarks(p.text)))];
    const nMatch = vals.filter(v => v.match).length;
    const status = !it.values.length ? 'no-values' : !pages.length ? (fetch.some(f => f.challenge || [401, 403, 429, 503].includes(f.status)) ? 'blocked' : 'unreadable') : nMatch === vals.length ? 'all-match' : nMatch ? 'partial' : 'mismatch';
    const seen = pages.map(p => { const e = evaluate(0, null, p.html, p.text); return { url: p.url, via: p.via, monthly: e.monthly.slice(0, 10), yearly: e.yearly.slice(0, 6) } });
    return { id: it.id, status, values: vals.map(v => ({ ...v, ctx: String(v.ctx || '').slice(0, 220) })), non_usd, seen, fetch, note: it.note } };
  const qq = [...items]; await Promise.all(Array.from({ length: 4 }, async () => { while (qq.length) { const it = qq.shift(); try { usCheck.items.push(await checkItem(it)) } catch (e) { usCheck.items.push({ id: it.id, status: 'error', error: String(e.message || e).slice(0, 120) }) } } }));
  usCheck.items.sort((a, b) => a.id.localeCompare(b.id));
} catch (e) { usCheck.error = String(e.message || e).slice(0, 200) } }
if (browserP) { const b = await browserP; if (b) await b.close().catch(() => { }) }
const order = new Map(data.tools.map((t, i) => [t.id, i])); results.sort((a, b) => order.get(a.id) - order.get(b.id));
const byId = new Map(data.tools.map(t => [t.id, t]));

// ---- apply the safety rules to proposals
const state = { pending: {}, held: {}, last_run: TODAY };
const approved = [], pending = [], held = [];
for (const r of results.filter(x => x.status === 'proposal')) {
  const t = byId.get(r.id), p = r.price, n = r.proposed; const pct = Math.abs(n - p) / p, drop = (p - n) / p;
  const item = { id: r.id, name: r.name, old: p, new: n, change_pct: +(100 * (n - p) / p).toFixed(1), sources: r.sources };
  const prev = prevState.pending?.[r.id] || prevState.held?.[r.id];
  const firstSeen = prev && same(prev.new ?? prev.value, n) ? (prev.first_seen || prev.last_seen) : TODAY;
  const consecutive = prev && same(prev.new ?? prev.value, n) && prev.last_seen === YESTERDAY;
  if (t.price_approx) { held.push({ ...item, reason: 'price_approx=true (stored price is an estimate) — manual review' }); continue }
  if (pct > 0.5 || drop > 0.3) { held.push({ ...item, reason: pct > 0.5 ? 'change > 50%' : 'drop > 30% (would notify every user)' }); continue }
  if (pct > 0.15 && r.sources.length < 2) { held.push({ ...item, reason: 'change 15–50% needs 2 independent official sources' }); continue }
  if (!consecutive) { pending.push({ ...item, reason: `day 1 of ${CFG.consecutive_days || 2}: needs the same unique value tomorrow`, first_seen: firstSeen }); continue }
  approved.push({ ...item, first_seen: firstSeen });
}
const proposedCount = approved.length + pending.length + held.length;
let breaker = false;
if (proposedCount > MAX_CHANGES) { breaker = true; for (const a of approved.splice(0)) held.push({ ...a, reason: `circuit breaker: ${proposedCount} proposed changes > ${MAX_CHANGES} — nothing published` }) }
for (const x of pending) state.pending[x.id] = { new: x.new, old: x.old, first_seen: x.first_seen, last_seen: TODAY };
for (const x of held) state.held[x.id] = { new: x.new, old: x.old, reason: x.reason, first_seen: prevState.held?.[x.id] && same(prevState.held[x.id].new, x.new) ? prevState.held[x.id].first_seen : TODAY, last_seen: TODAY };
for (const x of approved) state.pending[x.id] = undefined;

// ---- build the candidate dataset (in memory). Held/pending values NEVER enter it.
const confirmed = results.filter(r => r.status === 'confirmed');
const fixesApplied = {};
if (!breaker) {
  for (const r of confirmed) { const t = byId.get(r.id); const d = r.via === 'wayback' ? r.snapshot_date : TODAY;
    if (!t.price_captured_on || d > t.price_captured_on) t.price_captured_on = d;
    t.price_check_method = r.method; if (r.computed) t.price_monthly_computed = true; else if ('price_monthly_computed' in t) t.price_monthly_computed = false }
  for (const a of approved) { const t = byId.get(a.id); const p = a.old, n = a.new;
    t.price_prev_usd = p; t.price_usd = n; t.price_changed_on = TODAY; t.price_captured_on = TODAY; t.updated = TODAY; t.price_check_method = 'text';
    if (typeof t.price_note === 'string') t.price_note = t.price_note.replace(new RegExp(`(^|[^\\d.])${String(p).replace('.', '\\.')}(?=\\s?\\$)`, 'g'), `$1${n}`).replace(new RegExp(`\\$\\s?${String(p).replace('.', '\\.')}(?![\\d.])`, 'g'), `$${n}`) }
  for (const [id, f] of Object.entries(CFG.data_fixes || {})) { const t = byId.get(id); if (!t) continue; for (const [k, v] of Object.entries(f)) if (t[k] === v.from && v.to) { t[k] = v.to; (fixesApplied[id] ||= []).push(k) } }
}
const changed = JSON.stringify(data.tools) !== JSON.stringify(old.tools);
if (changed) data.built = TODAY;
const plan = { mode: 'publish', approved: approved.map(a => a.id), fixes: fixesApplied };
const acceptErrors = accept(old, data, plan);

// ---- report
const checkable = results.filter(r => r.status !== 'skipped');
const count = f => results.filter(f).length; const group = (arr, k) => arr.reduce((m, x) => ((m[x[k]] ||= []).push(x.id), m), {});
const summary = {
  date: TODAY, dry_run: DRY, render: RENDER, wayback: WAYBACK, total: results.length, checkable: checkable.length,
  confirmed: confirmed.length, coverage_checkable_pct: +(100 * confirmed.length / checkable.length).toFixed(1), coverage_total_pct: +(100 * confirmed.length / results.length).toFixed(1),
  confirmed_by_method: confirmed.reduce((m, r) => (m[r.method] = (m[r.method] || 0) + 1, m), {}),
  confirmed_computed_annual: count(r => r.status === 'confirmed' && r.computed), confirmed_wayback: count(r => r.via === 'wayback'),
  proposed_changes: proposedCount, approved: approved.length, pending: pending.length, held: held.length, circuit_breaker: breaker,
  unconfirmed: count(r => r.status === 'unconfirmed'), manual_converted_currency: count(r => r.status === 'manual'), skipped: count(r => r.status === 'skipped'),
  unconfirmed_by_cause: group(results.filter(r => r.status === 'unconfirmed'), 'cause'),
  app_acceptance: acceptErrors.length ? { ok: false, errors: acceptErrors.slice(0, 30) } : { ok: true },
  would_publish: !breaker && changed && !acceptErrors.length, data_fixes: fixesApplied,
};
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ summary, approved, pending, held, results }, null, 1));
fs.writeFileSync(path.join(OUT, 'state.json'), JSON.stringify(state, null, 1));
fs.writeFileSync(path.join(OUT, 'held.json'), JSON.stringify(held, null, 1));
fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify(plan, null, 1));
const md = [`# Price check ${TODAY} ${DRY ? '(DRY-RUN — data.json untouched)' : ''}`, '',
  `**Coverage:** ${confirmed.length}/${checkable.length} checkable (${summary.coverage_checkable_pct}%) · ${confirmed.length}/${results.length} total (${summary.coverage_total_pct}%)`, '',
  `By method: ${Object.entries(summary.confirmed_by_method).map(([k, v]) => `${k}=${v}`).join(', ')} · annual÷12 (computed) = ${summary.confirmed_computed_annual} · wayback = ${summary.confirmed_wayback}`, '',
  `Proposed changes: ${proposedCount} → approved ${approved.length}, pending (day 1) ${pending.length}, held ${held.length}${breaker ? ' — **CIRCUIT BREAKER: nothing published**' : ''}`, '',
  `App acceptance (remoteOk + notification gate): ${acceptErrors.length ? '❌ ' + acceptErrors.slice(0, 5).join('; ') : '✅ OK'} · would publish: ${summary.would_publish}`, '',
  '## Approved', ...(approved.length ? approved.map(a => `- ${a.id}: $${a.old} → $${a.new} (${a.change_pct}%) sources: ${a.sources.join(' , ')}`) : ['-']), '',
  '## Pending (needs a 2nd consecutive day)', ...(pending.length ? pending.map(a => `- ${a.id}: $${a.old} → $${a.new} (${a.change_pct}%) — ${a.reason}`) : ['-']), '',
  '## Held (kept last good value)', ...(held.length ? held.map(a => `- ${a.id}: $${a.old} → $${a.new} (${a.change_pct}%) — ${a.reason}`) : ['-']), '',
  '## Unconfirmed by cause', ...Object.entries(summary.unconfirmed_by_cause).map(([k, v]) => `- **${k}** (${v.length}): ${v.join(', ')}`), '',
  `Manual (converted currency): ${results.filter(r => r.status === 'manual').map(r => r.id).join(', ') || '-'}`, `Skipped: ${results.filter(r => r.status === 'skipped').map(r => `${r.id}(${r.cause})`).join(', ')}`, ''].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), md);
{ const cnt = k => usCheck.items.filter(x => x.status === k).length; usCheck.summary = { date: TODAY, dry_run: DRY, report_only: true, present: usCheck.present, items: usCheck.items.length,
    values: usCheck.items.reduce((n, x) => n + (x.values?.length || 0), 0), values_matched: usCheck.items.reduce((n, x) => n + (x.values || []).filter(v => v.match).length, 0),
    all_match: cnt('all-match'), partial: cnt('partial'), mismatch: cnt('mismatch'), blocked: cnt('blocked'), unreadable: cnt('unreadable'), error: cnt('error') };
  fs.writeFileSync(path.join(OUT, 'us-check.json'), JSON.stringify(usCheck, null, 1));
  const S = usCheck.summary; const umd = [`## US check list (report-only, changes nothing) — \`${US_LIST}\``, '',
    !usCheck.present ? '_list file not present in the repo — skipped_' : `Items ${S.items} · values ${S.values_matched}/${S.values} matched · all-match ${S.all_match} · partial ${S.partial} · mismatch ${S.mismatch} · blocked ${S.blocked} · unreadable ${S.unreadable}${usCheck.error ? ' · ERROR ' + usCheck.error : ''}`, '',
    ...usCheck.items.map(x => `- **${x.id}** ${x.status}${x.non_usd?.length ? ' ⚠️ non-USD on page: ' + x.non_usd.join('/') : ''}: ` + (x.values || []).map(v => `${v.match ? '✅' : '❌'} $${v.value}/${v.period}${v.label ? ' (' + v.label + ')' : ''}${v.match ? ' [' + v.method + ' ' + v.via + ']' : v.method ? ' [' + v.method + ']' : ''}`).join(' · ') + (x.seen?.length ? ` — seen monthly ${JSON.stringify([...new Set(x.seen.flatMap(s => s.monthly))].slice(0, 8))} yearly ${JSON.stringify([...new Set(x.seen.flatMap(s => s.yearly))].slice(0, 5))}` : '')), ''].join('\n');
  fs.writeFileSync(path.join(OUT, 'us-check.md'), umd); if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + umd) }
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
console.log(md.split('\n').slice(0, 12).join('\n'));

// ---- publish (only when NOT dry-run and everything passed)
const publish = !DRY && !breaker && changed && !acceptErrors.length;
if (!DRY && acceptErrors.length) { console.error('ABORT: app acceptance failed:\n- ' + acceptErrors.join('\n- ')); }
if (publish) {
  fs.writeFileSync(FILE, JSON.stringify(data));
  const logLines = [...approved.map(a => ({ date: TODAY, kind: 'change', ...a })), ...Object.entries(fixesApplied).map(([id, f]) => ({ date: TODAY, kind: 'data_fix', id, fields: f }))];
  if (logLines.length) fs.appendFileSync(path.join(path.dirname(path.resolve(FILE)), 'changes.log.jsonl'), logLines.map(l => JSON.stringify(l)).join('\n') + '\n');
}
const commitMsg = `daily price check ${TODAY}: ${confirmed.length}/${checkable.length} confirmed, ${approved.length} changed, ${pending.length} pending, ${held.length} held`;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `publish=${publish}\nheld=${held.length}\nsummary=${commitMsg}\n`);
if (!DRY && acceptErrors.length) process.exit(1);
