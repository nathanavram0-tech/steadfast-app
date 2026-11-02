// Builds knowledge/index.json from knowledge/library/**/*.md and knowledge/coverage.yaml.
// Quality gate: a document without real sources, dates, an evidence level, a summary, a practical
// application and limitations is rejected, so nothing unsourced reaches the coaches.
// Run: node scripts/build-knowledge.mjs   (also runs inside npm run build)
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { DEPARTMENTS, EVIDENCE, makeIndex, docStatus } from '../api/_knowledge.js';

const ROOT = 'knowledge/library';
const files = [];
(function walk(dir) { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.md')) files.push(p); } })(ROOT);

const errors = [], warnings = [];
const docs = [], chunks = [];
const seenUrl = new Map();
const REQUIRED_SECTIONS = ['Summary', 'Practical application', 'Limitations'];
const isDate = (s) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(String(s || ''));

for (const file of files.sort()) {
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) { errors.push(file + ': missing front matter'); continue; }
  let fm; try { fm = YAML.parse(m[1]); } catch (e) { errors.push(file + ': bad front matter: ' + e.message); continue; }
  const body = m[2].trim();
  const where = relative('.', file);
  const bad = (msg) => errors.push(where + ': ' + msg);
  if (!fm.id || !/^[a-z0-9-]+$/.test(fm.id)) bad('id must be kebab-case');
  if (!fm.title) bad('missing title');
  if (!DEPARTMENTS[fm.department]) bad('unknown department ' + fm.department);
  if (!EVIDENCE[fm.evidence]) bad('evidence must be 1-5');
  if (!isDate(fm.researched)) bad('researched date missing');
  if (!isDate(fm.verified)) bad('verified date missing');
  if (!Array.isArray(fm.sources) || !fm.sources.length) bad('needs at least one source');
  for (const s of fm.sources || []) {
    if (!s.url || !/^https?:\/\//.test(s.url)) bad('source without a link: ' + (s.title || '?'));
    if (!s.title) bad('source without a title');
    if (!s.by) bad('source without author/organization: ' + s.title);
    if (!isDate(s.published)) bad('source without publication date: ' + s.title);
    if (s.url) { const k = s.url.replace(/[#?].*$/, '').replace(/\/$/, ''); if (seenUrl.has(k) && seenUrl.get(k) !== fm.id) warnings.push(`${fm.id}: source also used by ${seenUrl.get(k)}: ${s.url}`); else seenUrl.set(k, fm.id); }
  }
  // Sections
  const parts = body.split(/^## /m).filter(Boolean);
  const sections = parts.map(p => { const nl = p.indexOf('\n'); return { heading: (nl < 0 ? p : p.slice(0, nl)).trim(), text: (nl < 0 ? '' : p.slice(nl + 1)).trim() }; }).filter(s => s.text);
  for (const r of REQUIRED_SECTIONS) if (!sections.some(s => s.heading.toLowerCase().startsWith(r.toLowerCase()))) bad('missing "## ' + r + '" section');
  if (docs.some(d => d.id === fm.id)) bad('duplicate id ' + fm.id);
  const summary = (sections.find(s => /^summary/i.test(s.heading)) || {}).text || '';
  const doc = {
    id: fm.id, title: fm.title, department: fm.department, type: fm.type || 'topic', topics: fm.topics || [], people: fm.people || [],
    evidence: fm.evidence, agents: fm.agents || [], researched: String(fm.researched), verified: String(fm.verified), review_by: fm.review_by ? String(fm.review_by) : null,
    status: fm.status || 'verified', conflicts: fm.conflicts || null, version: fm.version || 1,
    sources: (fm.sources || []).map(s => ({ title: s.title, by: s.by, url: s.url, published: String(s.published), kind: s.kind || '' })),
    summary: summary.replace(/\s+/g, ' ').slice(0, 400), file: where, sections,
  };
  docs.push(doc);
  // Chunks: one per section; long sections split on paragraphs (~1200 chars).
  sections.forEach((s, i) => {
    const paras = s.text.split(/\n\s*\n/); let buf = '', n = 0;
    const flush = () => { if (buf.trim()) chunks.push({ cid: `${doc.id}#${i}.${n++}`, doc: doc.id, title: doc.title, heading: s.heading, topics: doc.topics, people: doc.people, text: buf.trim() }); buf = ''; };
    for (const p of paras) { if ((buf + p).length > 1200 && buf) flush(); buf += (buf ? '\n\n' : '') + p; }
    flush();
  });
}

if (errors.length) { console.error('Knowledge library has problems:\n - ' + errors.join('\n - ')); process.exit(1); }

const cov = existsSync('knowledge/coverage.yaml') ? YAML.parse(readFileSync('knowledge/coverage.yaml', 'utf8')) : {};
const ids = new Set(docs.map(d => d.id));
const coverage = Object.entries(cov || {}).map(([dept, topics]) => ({ department: dept, topics: (topics || []).map(t => ({ topic: t.topic, docs: (t.docs || []).filter(x => ids.has(x)), missing: (t.docs || []).filter(x => !ids.has(x)) })) }));
coverage.forEach(c => c.topics.forEach(t => { if (t.missing.length) warnings.push(`coverage ${c.department}/${t.topic} lists unknown docs: ${t.missing.join(', ')}`); }));

const today = new Date().toISOString().slice(0, 10);
const byDept = {}; for (const k of Object.keys(DEPARTMENTS)) byDept[k] = { docs: 0, sources: 0, experts: 0 };
const allSources = new Set();
for (const d of docs) { byDept[d.department].docs++; byDept[d.department].sources += d.sources.length; if (d.type === 'expert') byDept[d.department].experts++; d.sources.forEach(s => allSources.add(s.url)); }
const stats = {
  built: new Date().toISOString(), docs: docs.length, chunks: chunks.length, sources: allSources.size, experts: docs.filter(d => d.type === 'expert').length,
  byDept, byEvidence: Object.fromEntries(Object.keys(EVIDENCE).map(k => [k, docs.filter(d => d.evidence === +k).length])),
  stale: docs.filter(d => docStatus(d, today) === 'stale').map(d => d.id), pending: docs.filter(d => docStatus(d, today) === 'pending').map(d => d.id),
  gaps: coverage.flatMap(c => c.topics.filter(t => !t.docs.length).map(t => ({ department: c.department, topic: t.topic }))),
  covered: coverage.reduce((n, c) => n + c.topics.filter(t => t.docs.length).length, 0), planned: coverage.reduce((n, c) => n + c.topics.length, 0),
};
const index = makeIndex(chunks);
writeFileSync('knowledge/index.json', JSON.stringify({ stats, coverage, docs, chunks, index: index.toJSON() }));
console.log(`knowledge: ${docs.length} docs, ${chunks.length} sections, ${allSources.size} sources, ${stats.gaps.length} gaps` + (warnings.length ? `\n  warnings:\n  - ${warnings.join('\n  - ')}` : ''));
