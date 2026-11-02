// Knowledge library retrieval for the coaches and the Library screen. No AI call happens here:
// it searches the app's own researched documents and returns sections with their citations.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { send, readJson, requireUser, missingEnv } from './_lib.js';
import { loadIndex, searchLibrary, AGENT_DEPTS, DEPARTMENTS, EVIDENCE, docStatus } from './_knowledge.js';

let LIB = null, MS = null;
function lib() {
  if (!LIB) {
    LIB = JSON.parse(readFileSync(join(process.cwd(), 'knowledge', 'index.json'), 'utf8'));
    MS = loadIndex(LIB.index);
  }
  return LIB;
}
const docMeta = (d) => ({ id: d.id, title: d.title, department: d.department, type: d.type, topics: d.topics, people: d.people, evidence: d.evidence, evidence_label: EVIDENCE[d.evidence],
  summary: d.summary, researched: d.researched, verified: d.verified, review_by: d.review_by, status: docStatus(d), conflicts: d.conflicts, sources: d.sources });

export default async function handler(req, res) {
  const miss = missingEnv(['SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  if (miss.length) return send(res, 500, { code: 'not_configured', message: 'Missing settings: ' + miss.join(', ') });
  const user = await requireUser(req);
  if (!user) return send(res, 401, { code: 'not_signed_in', message: 'Sign in again.' });
  let L; try { L = lib(); } catch (e) { return send(res, 500, { code: 'no_library', message: 'The knowledge library is not built: ' + String(e.message).slice(0, 120) }); }
  const q = req.query || {};
  if (req.method === 'GET') {
    if (q.stats) return send(res, 200, { stats: L.stats, coverage: L.coverage, departments: DEPARTMENTS, evidence: EVIDENCE,
      recent: [...L.docs].sort((a, b) => (a.verified < b.verified ? 1 : -1)).slice(0, 12).map(docMeta) });
    if (q.doc) { const d = L.docs.find(x => x.id === q.doc); return d ? send(res, 200, { doc: { ...docMeta(d), sections: d.sections } }) : send(res, 404, { code: 'not_found' }); }
    if (q.list) return send(res, 200, { docs: L.docs.filter(d => q.list === 'all' || d.department === q.list).map(docMeta) });
    return send(res, 400, { code: 'bad_request' });
  }
  if (req.method !== 'POST') return send(res, 405, { code: 'method' });
  let b; try { b = await readJson(req); } catch { return send(res, 400, { code: 'bad_json' }); }
  const query = String(b.query || '').slice(0, 500).trim();
  if (!query) return send(res, 400, { code: 'empty', message: 'No question.' });
  const asked = Array.isArray(b.departments) ? b.departments.filter(d => DEPARTMENTS[d]) : [];
  const departments = asked.length ? asked : (AGENT_DEPTS[b.agent] || AGENT_DEPTS.main);
  const hits = searchLibrary(L, MS, query, { departments, limit: Math.min(10, +b.limit || 6) });
  return send(res, 200, {
    query, departments, count: hits.length,
    results: hits.map(h => ({ doc: h.doc.id, title: h.doc.title, department: h.doc.department, section: h.chunk.heading, text: h.chunk.text,
      evidence: h.doc.evidence, evidence_label: EVIDENCE[h.doc.evidence], verified: h.doc.verified, status: docStatus(h.doc), conflicts: h.doc.conflicts,
      sources: h.doc.sources.map(s => ({ title: s.title, by: s.by, published: s.published, url: s.url })) })),
  });
}
