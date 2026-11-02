// Knowledge library: the quality gate rejects unsourced docs, retrieval finds the right document
// for real questions, departments filter by coach, and the API answers with citations.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let fails = 0; const ok = (c, m, info) => { console.log((c ? '  PASS ' : '  FAIL ') + m + (c ? '' : ' ' + JSON.stringify(info || ''))); if (!c) fails++; };

// 1. Quality gate
const dir = mkdtempSync(join(tmpdir(), 'kb-'));
cpSync('scripts', join(dir, 'scripts'), { recursive: true }); cpSync('api', join(dir, 'api'), { recursive: true }); cpSync('node_modules', join(dir, 'node_modules'), { recursive: true, dereference: false });
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
mkdirSync(join(dir, 'knowledge/library/physique'), { recursive: true });
writeFileSync(join(dir, 'knowledge/library/physique/bad.md'), '---\nid: bad-doc\ntitle: Bad\ndepartment: physique\nevidence: 2\nresearched: 2026-11-02\nverified: 2026-11-02\nsources: []\n---\n## Summary\nNo sources here.\n');
let rejected = false; try { execFileSync('node', ['scripts/build-knowledge.mjs'], { cwd: dir, stdio: 'pipe' }); } catch (e) { rejected = /needs at least one source/.test(String(e.stderr)); }
ok(rejected, 'a document without sources is rejected by the quality gate');

// 2. Retrieval quality on the real library
const K = await import('../api/_knowledge.js');
const L = JSON.parse(readFileSync('knowledge/index.json', 'utf8')); const ms = K.loadIndex(L.index);
const top = (q, agent) => (K.searchLibrary(L, ms, q, { departments: K.AGENT_DEPTS[agent], limit: 3 })[0] || { doc: {} }).doc.id;
const cases = [['How can I build more upper chest?', 'trainer', 'phys-upper-chest'], ['how much protein do I need', 'fuel', 'nut-protein-intake'], ['What does the Bible say about discipline?', 'faith', 'faith-discipline-scripture'],
  ['I keep procrastinating on editing', 'mind', 'disc-procrastination'], ['taxes on my videography side income', 'money', 'wealth-self-employment-tax'], ['is IGF-1 LR3 safe', 'trainer', 'health-igf1-peptides'],
  ['who was Greg Plitt and what was his mindset', 'main', 'expert-greg-plitt'], ['should I pay off the smallest debt first', 'money', 'wealth-debt-payoff'], ['how long until a habit sticks', 'mind', 'disc-habit-formation'],
  ['does sunscreen keep skin young', 'glow', 'app-sunscreen-skin-aging'], ['how many sets per week to grow', 'trainer', 'phys-weekly-volume'], ['make a better offer to get clients', 'money', 'expert-alex-hormozi'],
  ['how do I grow wider shoulders', 'trainer', 'phys-side-delts'], ['my left arm is smaller than my right', 'trainer', 'phys-unilateral-imbalances'], ['should I open a roth ira', 'money', 'wealth-roth-ira'],
  ['are index funds better than picking stocks', 'money', 'wealth-index-funds'], ['what should I charge for a wedding film', 'money', 'biz-wedding-video-pricing'], ['how fast should I reply to inquiries', 'money', 'biz-lead-response-speed'],
  ['I feel anxious, what does the Bible say', 'faith', 'faith-anxiety-prayer'], ['I keep getting distracted while editing and can\'t focus', 'mind', 'disc-focus-attention-residue']];
for (const [q, a, want] of cases) { const got = top(q, a); ok(got === want, `"${q}" (${a}) -> ${want}`, got); }
const faithOnly = K.searchLibrary(L, ms, 'protein', { departments: K.AGENT_DEPTS.faith, limit: 5 });
ok(faithOnly.every(h => K.AGENT_DEPTS.faith.includes(h.doc.department)), 'a coach only searches its own departments');
ok(L.docs.every(d => d.sources.length && d.sources.every(s => /^https?:/.test(s.url))), 'every document carries source links');

// 3. API
process.env.SUPABASE_URL = 'http://sb.test'; process.env.SUPABASE_ANON_KEY = 'anon';
globalThis.fetch = async () => new Response(JSON.stringify({ id: 'u1', email: 'nathan@example.com' }), { status: 200, headers: { 'content-type': 'application/json' } });
const { default: handler } = await import('../api/knowledge.js');
const call = (method, query, body) => new Promise(res => { const r = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { res({ status: this.statusCode, json: JSON.parse(b) }); } };
  handler({ method, query, body, headers: { authorization: 'Bearer jwt' } }, r); });
const a1 = await call('POST', {}, { query: 'upper chest incline', agent: 'trainer' });
ok(a1.status === 200 && a1.json.results[0].doc === 'phys-upper-chest' && a1.json.results[0].sources[0].url.startsWith('https://'), 'API returns the right section with its citation');
const a2 = await call('GET', { stats: '1' });
ok(a2.status === 200 && a2.json.stats.docs === L.docs.length && Array.isArray(a2.json.stats.gaps), 'API returns dashboard stats and gaps');
const a3 = await call('GET', { doc: 'expert-greg-plitt' });
ok(a3.status === 200 && a3.json.doc.sections.length >= 5, 'API returns a full document');
process.exit(fails ? 1 : 0);
