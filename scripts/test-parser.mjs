// node scripts/test-parser.mjs — fixtures are real snippets from the 2026-11-02 audit (the 28 parser-mismatch cases + regressions).
import { evaluate, candidates, embeddedPrices } from './price-lib.mjs';
const C = [ // [id, storedPrice, text, expectConfirm(true/false), expectMethod?]
  ['bolt', 25, 'Website hosting MOST POPULAR Pro $25 * /month Billed monthly Get Pro Everything in Free', true],
  ['grammarly', 12, 'Plans | Grammarly Free $0 USD / month Create account Pro $12 USD Try for free Email reminder', true, 'text-loose'],
  ['napkin', 9, 'Napkin branding on visuals Plus Popular $9 per person / month Get Started', true],
  ['descript', 24, 'Saving up to 35% over monthly plan Hobbyist $ 16 $ 24 per person / month 1 person included', true],
  ['descript-annual', 16, 'Saving up to 35% over monthly plan Hobbyist $ 16 $ 24 per person / month 1 person included', true, 'text-toggle'],
  ['elicit', 11, 'Plus For deeper research $11 Save 42% Per user/month, billed as $132 annually Export', true],
  ['durable', 25, ') * 2) 0} $25/m Everything you need to get found, booked, and paid.', true],
  ['gling', 20, 'videos produced monthly. $ 20 /mon Get Plus Now Start for Free', true],
  ['kapwing', 16, 'create more content in less time 1,000 credits / month $ 16 Upgrade Everything in Free', true, 'text-loose'],
  ['read-ai', 19.75, 'Workspace access $15 -25% $19.75 $19.75 USD. Per user / month when billed annually.', true],
  ['cleanvoice', 11, 'Credits purchased are valid for 2 years. $ 11 $ 2.20 /hour 5 Hours Processed Audio per Month.', false],
  ['replit', 20, 'Monthly Yearly Up to 10% off Core $20 $18 / month, billed annually For personal projects', true, 'text-toggle'],
  ['undetectable', 9.99, 'Monthly Yearly 50% off $ 9.99 $ 5.00 /mo 10K words/month Charged annually $60.00', true],
  ['krea', 35, '~65 Seedance 2.5 videos $35 $21 /month svg]:px-8', true],
  ['playground', 15, 'royalty free license Annual -20% $ 15 $ 12 /mo $ 144 will be charged in total annually', true],
  ['runway', 15, 'Save $36/year. For curious creators trying AI video $15 $12 /month 625 credits /mo', true],
  ['invideo', 9, '190 credits per seat/mo $9 $4 per seat/mo, billed annually Get Basic', true],
  ['fireflies', 18, 'small teams $18 $10 per seat / month, billed annually Get Started', true],
  ['riverside', 29, 'Pro + Live Studio $29 $24 /mo Billed $288 annually Start free trial', true],
  ['picsart', 15, 'everyday creative work. $ 15 $ 10.5 /mo Billed yearly Continue', true],
  ['mapify', 9.99, '1000 AI credits/month US$ 9.99 40% OFF US$ 5.99 /month billed yearly Get Basic', true],
  ['researchrabbit', 12.5, 'Sign Up ResearchRabbit+ $10* per month $12.5* per month Annual plan Monthly plan', true],
  ['pika', 10, 'Subscribe to Fancy Price / mo $0 $10 $35 $95–$880 Price / mo (annual, –20%) $0 $8 $28', true],
  ['v0', 30, 'Start Building Plus Popular $30 $ 90 /user/month Everything from Free Access to all models $30 of included monthly credits per user', true],
  ['plus-ai', 15, 'Basic $10 per user/month, billed annually. $15/user billed monthly. Best for individuals', true],
  ['maestra', 79, 'file sharing Subscribe Now Premium $79 Save $237 per month What you get', true],
  ['elevenlabs', 6, 'Starter $6 /month Everything in Free', true],
  ['otter', 16.99, 'small teams $16 .99 /user/month $16 .99 $8 .49* /user/month save 50% Buy now', true],
  ['humata', 9.99, 'Get Started Expert Popular $ 9 99 / month Moderate usage', true],
  ['smartcat', 100, 'direct the work. Starting at $1,200 / year Billed annually Start free trial', true, 'annual-computed'],
  ['filmora', 4.17, 'Basic Save extra US$ 49.99 /yr --> US$ --> 59.99', true, 'annual-computed'],
  ['clickup-changed', 7, 'Core $ 9 Regular price $ 12 user / mo · billed yearly', false],
  ['synthesia-firstmonth', 29, 'Starter First month for $9 $19 $9 first month per month then $19 per month', false],
  ['writesonic-year-first', 240, 'Starter $79 Save $240/year per month, billed annually', false],
  ['photoai-nospace', 19, 'Pricing Monthly Yearly: get 6+ months free Starter $19per month Get started', true],
  ['hedra-api', 20, 'Input tokens from $0.15 / 1M tokens Output tokens from $0.50 / 1M tokens', false],
];
let fail = 0;
for (const [id, p, txt, exp, meth] of C) { const r = evaluate(p, null, '', txt); const ok = !!r.confirm === exp && (!meth || (r.confirm && r.confirm.method === meth));
  if (!ok) { fail++; console.log('FAIL', id, JSON.stringify(r.confirm), 'month=', r.monthly, 'year=', r.yearly, 'strict=', r.strict) } else console.log('ok  ', id, r.confirm ? r.confirm.method : '-') }
// strict (change) candidates must exclude annual-billed and first-month promo prices
const s = evaluate(29, null, '', 'Starter First month for $9 $19 $9 first month per month then $19 per month'); if (s.strict.includes(9)) { fail++; console.log('FAIL first-month promo leaked into strict', s.strict) }
const r2 = evaluate(20, null, '', 'Core $20 $18 / month, billed annually'); if (r2.strict.length) { fail++; console.log('FAIL annual leaked into strict', r2.strict) }
// embedded
const e = embeddedPrices('<script type="application/ld+json">{"@type":"Offer","price":"12.00","priceCurrency":"USD","priceSpecification":{"@type":"UnitPriceSpecification","price":12,"priceCurrency":"USD","unitText":"MONTH"}}</script><script>self.__next_f.push([1,"{\\"monthlyPrice\\":28,\\"name\\":\\"Standard\\"}"])</script>');
if (!e.some(x => x.kind === 'jsonld' && x.v === 12 && x.period === 'month') || !e.some(x => x.kind === 'embedded' && x.v === 28 && x.period === 'month')) { fail++; console.log('FAIL embedded', e) } else console.log('ok   embedded', e.length);
// fetch_profile / geo hints
{ const { nonUsdMarks } = await import('./price-lib.mjs');
  const a = nonUsdMarks('Creator E£ 499 / month'), b = nonUsdMarks('Creator $12 per user / month');
  if (!(a.includes('EGP') && !a.includes('GBP') && b.length === 0)) { console.error('FAIL nonUsdMarks', a, b); process.exit(1) } else console.log('ok nonUsdMarks') }
{ const c = JSON.parse((await import('node:fs')).readFileSync(new URL('./price-config.json', import.meta.url), 'utf8'));
  if (c.fetch_profile?.veed?.locale !== 'en-US' || !/^en-US/.test(c.fetch_profile.veed.accept_language)) { console.error('FAIL veed profile'); process.exit(1) } else console.log('ok veed US profile') }
{ const { normalizeList, matchValue } = await import('./us-check-lib.mjs');
  const l = normalizeList({ _meta: {}, photoroom: { price_usd: 12.99, price_yearly_usd: 89.99, price_yearly_source: 'https://www.photoroom.com/pricing' }, x: { values: [7, { v: 3, unit: 'yearly' }], url: 'https://x.io/p' } });
  const txt = 'Pro $12.99 / month or $89.99 billed yearly. Max $34.99 per month';
  const ok = l.length === 2 && l[0].values.length === 2 && l[1].values[1].period === 'year' && matchValue(12.99, 'month', '', txt).match && matchValue(89.99, 'year', '', txt).match && !matchValue(34.99, 'year', '', txt).match && !matchValue(5, 'any', '', txt).match && !matchValue(9.99, 'any', '', 'only $19.99 here').match;
  if (!ok) { console.error('FAIL us-check', JSON.stringify(l)); process.exit(1) } else console.log('ok us-check list/match') }
{ const { normalizeList, matchValue } = await import('./us-check-lib.mjs');
  const l = normalizeList({ _meta: {}, items: [{ tool: 'photoroom', field: 'price_usd', value: 12.99, currency: 'USD', url: 'https://www.photoroom.com/pricing' }, { tool: 'photoroom', field: 'price_yearly_usd', value: 89.99, currency: 'USD', url: 'https://www.photoroom.com/pricing' }, { tool: 'jasper', field: 'offers[annual].discount_pct', value: 14, currency: '%', url: 'https://www.jasper.ai/pricing' }] });
  const pr = l.find(x => x.id === 'photoroom'), j = l.find(x => x.id === 'jasper');
  const ok = l.length === 2 && pr.values.map(v => v.period).join() === 'month,year' && j.values[0].period === 'percent' && matchValue(14, 'percent', '', 'Save 14% with annual').match && !matchValue(4, 'percent', '', 'Save 14%').match;
  if (!ok) { console.error('FAIL us-check rows', JSON.stringify(l)); process.exit(1) } else console.log('ok us-check flat rows') }
console.log(fail ? `${fail} FAILED` : 'all parser tests passed'); process.exit(fail ? 1 : 0);
