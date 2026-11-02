// Steadfast knowledge library: shared by the build script (indexing) and /api/knowledge (retrieval).
//
// Source of truth: knowledge/library/<department>/<id>.md, one researched document per file, with
// front matter (sources, dates, evidence level, agents) and a body split into "## " sections.
// The build turns each section into a searchable chunk and writes knowledge/index.json.
// Search is BM25-style full text (MiniSearch) with English stemming, fuzzy and prefix matching,
// field boosts and a synonym list, filtered by department. No paid API is involved.
import MiniSearch from 'minisearch';

export const DEPARTMENTS = {
  physique: 'Physique & bodybuilding',
  nutrition: 'Nutrition & supplements',
  health: 'Health & performance',
  appearance: 'Skin, face & grooming',
  business: 'Business & entrepreneurship',
  wealth: 'Wealth & personal finance',
  faith: 'Faith & the Bible',
  discipline: 'Discipline & psychology',
  communication: 'Communication & leadership',
};
// Which departments each coach searches by default. The head coach searches everything.
export const AGENT_DEPTS = {
  main: Object.keys(DEPARTMENTS),
  trainer: ['physique', 'nutrition', 'health'],
  fuel: ['nutrition', 'health', 'physique'],
  glow: ['appearance', 'health', 'nutrition'],
  money: ['wealth', 'business', 'communication'],
  faith: ['faith', 'discipline'],
  mind: ['discipline', 'communication', 'health', 'faith'],
};
export const EVIDENCE = {
  1: 'Strong scientific or historical evidence',
  2: 'Moderate supporting evidence',
  3: 'Expert opinion and practical experience',
  4: 'Emerging or experimental',
  5: 'Unsupported or disputed',
};

// Light English stemmer: enough to match "squats/squatting/squatted", "muscles/muscular" etc.
export function stem(w) {
  w = w.toLowerCase();
  if (w.length <= 3) return w;
  const rules = [[/ies$/, 'y'], [/(ss)es$/, '$1'], [/([^s])s$/, '$1'], [/ational$/, 'ate'], [/ization$/, 'ize'], [/fulness$/, 'ful'], [/ousness$/, 'ous'], [/iveness$/, 'ive'], [/ing$/, ''], [/edly$/, ''], [/ed$/, ''], [/ly$/, ''], [/ment$/, ''], [/ness$/, '']];
  for (const [re, to] of rules) { if (re.test(w)) { const s = w.replace(re, to); if (s.length >= 3) { w = s; break; } } }
  return w.replace(/(.)\1$/, '$1');
}
const STOP = new Set('a an and are as at be but by for from has have how i in is it its of on or that the this to was what when where which who why will with you your my me do does did can should would'.split(' '));
// Everyday words → the words the research uses. Expands queries only.
const SYN = {
  'upper chest': 'clavicular pectoralis incline', 'lower chest': 'sternal costal decline dip', 'side delt': 'lateral deltoid raise', 'rear delt': 'posterior deltoid',
  'front delt': 'anterior deltoid', bulk: 'surplus gain weight', bulking: 'surplus gain weight', cut: 'deficit fat loss', cutting: 'deficit fat loss', lean: 'body fat leanness',
  gains: 'hypertrophy muscle growth', growth: 'hypertrophy', grow: 'hypertrophy', size: 'hypertrophy', strength: 'strength 1rm', reps: 'repetition range', failure: 'proximity failure rir',
  rir: 'reps in reserve proximity failure', sets: 'volume', frequency: 'frequency per week', cardio: 'aerobic endurance concurrent', abs: 'abdominal core', arms: 'biceps triceps',
  biceps: 'elbow flexor', triceps: 'elbow extensor', glutes: 'gluteus', quads: 'quadriceps', hams: 'hamstrings', calves: 'gastrocnemius soleus', lats: 'latissimus back',
  protein: 'protein amino acid leucine', creatine: 'creatine monohydrate', sleep: 'sleep circadian', stress: 'cortisol stress', testosterone: 'testosterone hormone androgen',
  peptide: 'peptide igf-1 unapproved', peptides: 'peptide igf-1 unapproved', bloat: 'water retention sodium puffiness', puffy: 'water retention sodium puffiness', skin: 'skin sunscreen retinoid acne',
  money: 'finance', invest: 'investing index fund', investing: 'index fund diversification', debt: 'debt interest', budget: 'budgeting cash flow', save: 'saving emergency fund',
  clients: 'customer acquisition sales leads', customers: 'customer acquisition', sell: 'sales', selling: 'sales closing', price: 'pricing', marketing: 'marketing content brand',
  discipline: 'self-control habit consistency', procrastinate: 'procrastination', procrastination: 'procrastination delay', habits: 'habit formation', motivation: 'motivation',
  pray: 'prayer', prayer: 'prayer', bible: 'scripture', god: 'god', jesus: 'jesus christ gospel', anxious: 'anxiety worry', anxiety: 'anxiety worry', speak: 'public speaking', speaking: 'public speaking',
};
export function expandQuery(q) {
  const low = String(q || '').toLowerCase();
  const extra = [];
  for (const [k, v] of Object.entries(SYN)) if (new RegExp('\\b' + k.replace(/ /g, '\\s+') + '\\b').test(low)) extra.push(v);
  return (low + ' ' + extra.join(' ')).trim();
}
const tokenize = (s) => String(s || '').toLowerCase().split(/[^a-z0-9À-ɏ]+/).filter(Boolean);
const processTerm = (t) => (STOP.has(t) ? null : stem(t));

export const SEARCH_OPTIONS = {
  fields: ['title', 'heading', 'topics', 'text', 'people'],
  storeFields: [],
  tokenize,
  processTerm,
};
export const QUERY_OPTIONS = { boost: { title: 3, topics: 2.5, heading: 2, people: 2, text: 1 }, fuzzy: 0.18, prefix: true, combineWith: 'OR' };

export function makeIndex(chunks) {
  const ms = new MiniSearch({ ...SEARCH_OPTIONS, idField: 'cid' });
  ms.addAll(chunks.map(c => ({ cid: c.cid, title: c.title, heading: c.heading, topics: (c.topics || []).join(' '), people: (c.people || []).join(' '), text: c.text })));
  return ms;
}
export function loadIndex(json) {
  return MiniSearch.loadJSON(JSON.stringify(json), { ...SEARCH_OPTIONS, idField: 'cid' });
}

// Search: returns the best sections, at most `perDoc` per document, with the document's citation data.
export function searchLibrary(lib, ms, query, { departments, limit = 6, perDoc = 2, minEvidence } = {}) {
  const q = expandQuery(query);
  if (!q) return [];
  const depts = departments && departments.length ? new Set(departments) : null;
  const chunkById = lib._chunkById || (lib._chunkById = new Map(lib.chunks.map(c => [c.cid, c])));
  const docById = lib._docById || (lib._docById = new Map(lib.docs.map(d => [d.id, d])));
  const raw = ms.search(q, QUERY_OPTIONS);
  const out = []; const per = {};
  for (const r of raw) {
    const c = chunkById.get(r.id); if (!c) continue;
    const d = docById.get(c.doc); if (!d) continue;
    if (depts && !depts.has(d.department)) continue;
    if (minEvidence && d.evidence > minEvidence) continue;
    // Better evidence ranks a little higher on equal relevance.
    const score = r.score * (1 + (3 - Math.min(5, d.evidence || 3)) * 0.06);
    per[d.id] = (per[d.id] || 0) + 1; if (per[d.id] > perDoc) continue;
    out.push({ score, chunk: c, doc: d });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Status used by the dashboard: a document is stale once its review date has passed.
export function docStatus(d, today = new Date().toISOString().slice(0, 10)) {
  if (d.status === 'pending') return 'pending';
  if (d.review_by && d.review_by < today) return 'stale';
  return 'verified';
}
