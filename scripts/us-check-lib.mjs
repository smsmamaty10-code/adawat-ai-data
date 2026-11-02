// US check list: compare listed values against the US pricing pages. REPORT-ONLY — never changes data.json.
// Input (repo file us-check-list.json, tolerant shapes):
//   • array of items, or {items:[...]}, or a map {<tool id>: item} (keys starting with "_" are skipped)
//   • item: {id, url?|urls?, values?:[{value|v, period:'month'|'year'|'any', label?}], price_usd?, price_yearly_usd?, price_yearly_source?, note?}
//     price_usd → a 'month' value, price_yearly_usd → a 'year' value (when values[] is absent they are derived).
import { candidates, embeddedPrices, normalizeMoney, same, nonUsdMarks } from './price-lib.mjs';

export function normalizeList(raw) {
  let arr = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : raw && typeof raw === 'object'
    ? Object.entries(raw).filter(([k]) => !k.startsWith('_')).map(([k, v]) => ({ id: k, ...(v && typeof v === 'object' ? v : {}) })) : [];
  return arr.filter(x => x && x.id).map(x => {
    let values = Array.isArray(x.values) ? x.values.map(v => typeof v === 'number' ? { value: v, period: 'any' } : { value: +(v.value ?? v.v ?? v.price), period: v.period || v.unit || 'any', label: v.label || v.plan || '' }) : [];
    if (!values.length) {
      if (typeof x.price_usd === 'number' && x.price_usd > 0) values.push({ value: x.price_usd, period: 'month', label: 'price_usd' });
      if (typeof x.price_yearly_usd === 'number' && x.price_yearly_usd > 0) values.push({ value: x.price_yearly_usd, period: 'year', label: 'price_yearly_usd' });
    }
    values = values.filter(v => isFinite(v.value) && v.value > 0).map(v => ({ ...v, period: /^(mo|month|monthly)$/i.test(v.period) ? 'month' : /^(yr|year|yearly|annual)$/i.test(v.period) ? 'year' : 'any' }));
    const urls = [...new Set([...(Array.isArray(x.urls) ? x.urls : []), x.url, x.price_url, x.price_yearly_source, x.source].filter(u => typeof u === 'string' && /^https?:\/\//.test(u)))];
    return { id: String(x.id), urls, values, note: x.note || x.reason || '' };
  });
}

const lit = (t, v) => { const s = String(v).replace('.', '\\.'); const s2 = Number.isInteger(v) ? `${v}(?:\\.00)?` : s;
  return new RegExp(`(?:US\\$|\\$|USD)\\s?${s2}(?![\\d.,]\\d)|${s2}\\s?(?:US\\$|\\$|USD)(?![a-z])`, 'i').exec(t) };

// match one value on one page. period 'month' needs a monthly unit (text or embedded); 'year' a yearly one; 'any' just "$v".
export function matchValue(value, period, html, text) {
  const cs = candidates(text), emb = html ? embeddedPrices(html) : [];
  const want = period === 'month' ? ['month', 'loose'] : period === 'year' ? ['year'] : null;
  const c = cs.find(c => same(c.v, value) && (!want || want.includes(c.period)));
  if (c) return { match: true, method: 'text-' + c.period, ctx: c.ctx.slice(0, 200) };
  const e = emb.find(e => same(e.v, value) && (!want || e.period === period || (period === 'month' && e.period === 'month')));
  if (e) return { match: true, method: e.kind + (e.period ? '-' + e.period : ''), ctx: `${e.kind} (${e.period || 'no period'})` };
  const t = normalizeMoney(text); const m = lit(t, value);
  if (m) { const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40), ctx = t.slice(Math.max(0, m.index - 100), m.index + 100).trim();
    const unit = /^\W{0,3}(?:\/\s?(?:yr|year)|per\s+year|a\s+year|yearly|annually|billed\s+(?:yearly|annually)|\/\s?annum)/i.test(after) ? 'year'
      : /^\W{0,3}(?:\/\s?(?:mo|month)|per\s+month|a\s+month|monthly|billed\s+monthly)/i.test(after) ? 'month' : null;
    if (!want) return { match: true, method: 'text-any', ctx };
    if (unit === period) return { match: true, method: 'text-literal-' + unit, ctx };
    return { match: false, method: 'text-found-other-or-no-period', ctx } }
  return { match: false, method: null, ctx: '' };
}

export function pageSummary(text) { return { non_usd: nonUsdMarks(text) } }
