// Opens one GitHub Issue per held price change (bot-team queue). Uses the gh CLI with the workflow's GITHUB_TOKEN only.
// Idempotent: skips if an open issue with the same title already exists. Never touches data.json.
import fs from 'fs'; import { execFileSync } from 'child_process';
const held = JSON.parse(fs.readFileSync(process.argv[2] || 'out/held.json', 'utf8'));
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8' });
try { gh('label', 'create', 'price-hold', '--color', 'D93F0B', '--description', 'Held price change — bot team review', '--force') } catch { }
const open = JSON.parse(gh('issue', 'list', '--label', 'price-hold', '--state', 'open', '--limit', '200', '--json', 'title')).map(i => i.title);
for (const h of held) {
  const title = `[price-hold] ${h.id}: $${h.old} → $${h.new} (${h.change_pct}%)`;
  if (open.includes(title)) { console.log('exists:', title); continue }
  const body = [`**Tool:** ${h.name || h.id} (\`${h.id}\`)`, `**Stored (kept, still published):** $${h.old}`, `**Seen on page:** $${h.new} (${h.change_pct}%)`,
    `**Why held:** ${h.reason}`, `**Sources:** ${(h.sources || []).join(' , ')}`, '', 'The last good value and its last-verified date stay in data.json. To apply: edit data.json manually (bump `updated`), or let the bot re-propose it once the rules pass.'].join('\n');
  gh('issue', 'create', '--title', title, '--label', 'price-hold', '--body', body); console.log('opened:', title);
}
