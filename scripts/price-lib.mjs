// Pure parsing helpers for the price checker (no I/O). Covered by scripts/test-parser.mjs.
// All extraction is conservative: "loose" and "embedded" candidates may only CONFIRM an existing price, never change it.

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", dollar: '$', euro: '€', pound: '£', thinsp: ' ', ensp: ' ', emsp: ' ', ndash: '–', mdash: '—' };
export function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

// HTML → visible text (scripts/styles removed). Embedded JSON is read separately by embeddedPrices().
export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/[\u00a0\u2009\u202f\u200b]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Normalise money formatting quirks seen on pricing pages.
export function normalizeMoney(t) {
  return String(t)
    .replace(/\bUS\s?\$/g, '$').replace(/\bUSD\s?\$/g, '$')
    .replace(/\$\s*(\d+)\s+\.(\d{2})(?!\d)/g, '$$$1.$2')                       // "$16 .99"
    .replace(/\$\s*(\d{1,4})\s(\d{2})(?=\s*(?:\/|per\b|USD|\*|a\s+month))/gi, '$$$1.$2') // "$ 9 99 / month" (superscript cents)
    .replace(/\$\s+(?=\d)/g, '$')                                             // "$ 15" → "$15"
    .replace(/(\$\d[\d,]*(?:\.\d+)?)\s?\*+/g, '$1');                           // "$25 *", "$10*"
}

const NUM = String.raw`\$(\d{1,3}(?:,\d{3})+|\d{1,5})(?:\.(\d{1,2}))?(?![\d.,]*\d)`;
const WHO = String.raw`(?:user|seat|member|person|editor|creator|agent|license)`;
const MONTH_RE = new RegExp(String.raw`^(?:[^$]{0,45}?)(?:(?:\/|(?<![a-z])per\b|\ba\b)\s*(?:${WHO}\s*(?:\/|(?<![a-z])per\b)?\s*)?(?:mo|mon|mth|month|m)\b|\bbilled\s+monthly\b)|^\s*(?:USD\s*)?monthly\b(?!\s*(?:credit|\/|yearly|annual))`, 'i');
const YEAR_RE = new RegExp(String.raw`^(?:[^$]{0,45}?)(?:\/|(?<![a-z])per\b|\ba\b)\s*(?:${WHO}\s*(?:\/|(?<![a-z])per\b)?\s*)?(?:yr|year|annum)\b`, 'i');
const OTHER_UNIT_RE = /^(?:[^$]{0,30}?)(?:\/|(?<![a-z])per\b)\s*(?:hour|hr|min|minute|second|sec|credit|token|1m|image|video|page|word|char|gb|day|week|call|request)\b|^\s*(?:one[- ]time|lifetime|once)/i;
const ANNUAL_CTX = /annual|yearly|\/\s*yr\b|\/\s*year|per year|billed\s+(?:annually|yearly)|charged annually|paid annually/i;
const FIRST_MONTH_CTX = /first month|1st month|then \$/i;

// Extract $ candidates from visible text.
// returns [{v, period:'month'|'year'|'loose', annual, firstMonth, ctx, idx}]
export function candidates(rawText) {
  const t = normalizeMoney(rawText);
  const re = new RegExp(NUM, 'g');
  const ms = [...t.matchAll(re)].map(m => ({ v: +(m[1].replace(/,/g, '') + (m[2] ? '.' + m[2] : '')), idx: m.index, end: m.index + m[0].length }));
  // segment after each price = text up to next price (max 70 chars)
  for (let i = 0; i < ms.length; i++) {
    const stop = i + 1 < ms.length ? ms[i + 1].idx : t.length;
    ms[i].seg = t.slice(ms[i].end, Math.min(stop, ms[i].end + 70));
    ms[i].gapToNext = i + 1 < ms.length ? ms[i + 1].idx - ms[i].end : Infinity;
    if (OTHER_UNIT_RE.test(ms[i].seg)) ms[i].unit = 'other';
    else { const mm = ms[i].seg.match(MONTH_RE), yy = ms[i].seg.match(YEAR_RE);   // the unit that appears FIRST wins ("$240/year per month" → year)
      if (mm && (!yy || mm[0].length <= yy[0].length)) ms[i].unit = 'month'; else if (yy) ms[i].unit = 'year' }
  }
  // toggle groups: "$A $B /mo", "$15 -25% $19.75 USD. Per user / month", "US$ 9.99 40% OFF US$ 5.99 /month"
  for (let i = ms.length - 2; i >= 0; i--) {
    if (!ms[i].unit && ms[i].gapToNext <= 30 && !/[.!?]\s+[A-Z]/.test(ms[i].seg) && ms[i + 1].unit) { ms[i].unit = ms[i + 1].unit; ms[i].grouped = true }
  }
  const out = [];
  for (const m of ms) {
    if (!(m.v > 0 && m.v < 100000)) continue;
    const ctx = t.slice(Math.max(0, m.idx - 110), m.end + 110);
    let period = m.unit === 'month' ? 'month' : m.unit === 'year' ? 'year' : null;
    if (!period && !m.unit) {
      // loose: no unit after, but a month unit shortly BEFORE (e.g. "Free $0 USD / month … Pro $12 USD", "1,000 credits / month $ 16")
      const before = t.slice(Math.max(0, m.idx - 40), m.idx);
      if (/(?:\/|per)\s*(?:mo|month)\b|monthly/i.test(before) && !/\/\s*(?:yr|year)/i.test(before)) period = 'loose';
    }
    if (!period) continue;
    out.push({ v: m.v, period, annual: ANNUAL_CTX.test(ctx), firstMonth: FIRST_MONTH_CTX.test(t.slice(Math.max(0, m.idx - 40), m.end + 40)), grouped: !!m.grouped, ctx: ctx.trim() });
  }
  return out;
}

// Structured / embedded data: JSON-LD Offer objects, framework state blobs (__NEXT_DATA__, __NUXT__, RSC pushes) and generic "price": n pairs.
// returns [{v, period:'month'|'year'|null, kind:'jsonld'|'embedded', currency}]
export function embeddedPrices(html) {
  const out = [];
  const push = (v, period, kind, currency) => { v = +v; if (v > 0 && v < 100000 && (!currency || /^usd$/i.test(currency))) out.push({ v: Math.round(v * 100) / 100, period, kind, currency: currency || null }) };
  const periodOf = o => { const s = JSON.stringify([o.unitText, o.billingDuration, o.interval, o.billing_period, o.billingPeriod, o.period, o.recurring && o.recurring.interval, o.billingCycle, o.unitCode]).toLowerCase();
    return /month|\bmon\b|p1m|"mo"|mth/.test(s) ? 'month' : /year|annual|p1y|"yr"|ann/.test(s) ? 'year' : null };
  const walk = (o, kind, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 40) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, kind, depth + 1); return }
    const cur = o.priceCurrency || o.currency || o.currencyCode || (o.priceSpecification && o.priceSpecification.priceCurrency);
    for (const k of ['price', 'amount', 'monthlyPrice', 'monthly_price', 'priceMonthly', 'price_monthly', 'yearlyPrice', 'yearly_price', 'unit_amount', 'lowPrice']) {
      if (o[k] == null || (typeof o[k] !== 'number' && !(typeof o[k] === 'string' && /^\d+(\.\d+)?$/.test(o[k])))) continue;
      let v = +o[k]; if (k === 'unit_amount') v = v / 100;
      const p = /monthly|Monthly/.test(k) ? 'month' : /yearly/.test(k) ? 'year' : periodOf(o);
      if (kind === 'jsonld' || p || cur) push(v, p, kind, typeof cur === 'string' ? cur : null);
    }
    if (o.priceSpecification) walk(o.priceSpecification, kind, depth + 1);
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object') walk(o[k], kind, depth + 1);
  };
  for (const m of String(html).matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { walk(JSON.parse(m[1]), 'jsonld') } catch { } }
  for (const m of String(html).matchAll(/<script[^>]*id=["'](?:__NEXT_DATA__|__NUXT_DATA__)["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { walk(JSON.parse(m[1]), 'embedded') } catch { } }
  // generic raw pairs inside any script (incl. escaped RSC payloads): "monthlyPrice":20 / \"price\":\"20\" … with "month" nearby
  const raw = String(html).replace(/\\"/g, '"');
  for (const m of raw.matchAll(/"(price|amount|monthlyPrice|monthly_price|priceMonthly|price_monthly|yearlyPrice|yearly_price)"\s*:\s*"?(\d{1,5}(?:\.\d{1,2})?)"?/g)) {
    const near = raw.slice(Math.max(0, m.index - 160), m.index + 160);
    if (/€|eur|gbp|£|inr|₹|egp|jpy|¥/i.test(near) && !/usd|\$/i.test(near)) continue;
    const p = /monthly|Monthly/.test(m[1]) || /month|"mo"|\bmonthly\b/i.test(near) ? 'month' : /yearly/.test(m[1]) || /year|annual/i.test(near) ? 'year' : null;
    if (p) out.push({ v: +m[2], period: p, kind: 'embedded', currency: null });
  }
  return out;
}

export const same = (a, b) => Math.abs(a - b) < 0.006;
export const monthlyFromYear = y => Math.round((y / 12) * 100) / 100;

const CHALLENGE = /Just a moment\.\.\.|cf-browser-verification|challenge-platform\/|Attention Required! \| Cloudflare|_Incapsula_Resource|px-captcha|Access to this page has been denied|DataDome/i;
export const isChallenge = (status, html) => status === 403 || status === 429 || status === 503 || CHALLENGE.test(String(html || '').slice(0, 20000));

// local-currency / geo-pricing hints on a page (e.g. the page was served for Egypt instead of the US)
export function nonUsdMarks(text) { const t = String(text || ''); const out = [];
  for (const [k, re] of [['EGP', /E£|EGP|ج\.م/], ['EUR', /€\s?\d|\d\s?€/], ['GBP', /(?<!E)£\s?\d/], ['INR', /₹\s?\d/], ['TRY', /₺\s?\d/], ['SAR', /SAR\s?\d|ر\.س/], ['AED', /AED\s?\d/]]) if (re.test(t)) out.push(k);
  return out }
// Evaluate one page for a tool with stored monthly price p.
// returns {confirm: null|{method, value, ctx}, strict:[values usable for change proposals], all:[...], yearly:[...]}
export function evaluate(p, yearlyStored, html, text) {
  const cs = candidates(text);
  const emb = html ? embeddedPrices(html) : [];
  const month = cs.filter(c => c.period === 'month'), loose = cs.filter(c => c.period === 'loose'), year = cs.filter(c => c.period === 'year');
  let confirm = null;
  const hit = month.find(c => same(c.v, p));
  if (hit) confirm = { method: hit.grouped ? 'text-toggle' : 'text', value: p, ctx: hit.ctx };
  if (!confirm) { const j = emb.find(e => e.kind === 'jsonld' && e.period === 'month' && same(e.v, p)); if (j) confirm = { method: 'jsonld', value: p, ctx: 'JSON-LD Offer' } }
  if (!confirm) { const e = emb.find(e => e.period === 'month' && same(e.v, p)); if (e) confirm = { method: 'embedded-json', value: p, ctx: 'embedded JSON (month)' } }
  if (!confirm) { const l = loose.find(c => same(c.v, p)); if (l) confirm = { method: 'text-loose', value: p, ctx: l.ctx } }
  if (!confirm) { // annual → monthly equivalent (COMPUTED, not an official monthly price)
    const ys = [...year.map(c => c.v), ...emb.filter(e => e.period === 'year').map(e => e.v)];
    const y = ys.find(v => same(monthlyFromYear(v), p) || (yearlyStored && same(v, yearlyStored) && same(monthlyFromYear(v), p)));
    if (y != null) confirm = { method: 'annual-computed', value: p, computed: true, ctx: `$${y}/year ÷ 12 = $${monthlyFromYear(y)} (محسوب وليس سعرًا شهريًا رسميًا)` };
  }
  // strict candidates for change proposals: explicit monthly text, not annual-billed, not first-month promo; plus JSON-LD monthly
  const strict = [...new Set([...month.filter(c => !c.annual && !c.firstMonth).map(c => c.v), ...emb.filter(e => e.kind === 'jsonld' && e.period === 'month').map(e => e.v)])];
  return { confirm, strict, monthly: [...new Set(month.map(c => c.v))], yearly: [...new Set(year.map(c => c.v))], embeddedCount: emb.length, textLen: text.length, dollars: [...new Set(cs.map(c => c.v))], snips: cs.slice(0, 4).map(c => String(c.ctx || '').slice(0, 120)), nonUsd: nonUsdMarks(text), dollarCount: (normalizeMoney(text).match(/\$\d/g) || []).length };
}
