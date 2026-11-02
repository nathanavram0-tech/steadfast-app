// Steadfast standalone runtime.
// The app was built for Claude's artifact runtime (window.claude.use('db' | 'user' | 'sample' | ...)).
// This file provides the same interface backed by our own services, so the app code barely changes:
//   db      -> Supabase table `docs` (row level security: only you can read/write your rows)
//   user    -> the signed-in Supabase user
//   sample  -> /api/coach (Gemini, key stays on the server), with the app's own tools run here
//   downloads -> a normal file download
import { createClient } from '@supabase/supabase-js';

const S = { sb: null, user: null, ready: null, cfgErr: '' };
const $ = (sel) => document.querySelector(sel);

async function loadConfig() {
  const r = await fetch('/api/config', { cache: 'no-store' });
  if (!r.ok) throw new Error('config ' + r.status);
  const c = await r.json();
  if (!c.supabaseUrl || !c.supabaseAnonKey) throw new Error('Supabase settings are missing on the server.');
  return c;
}

export async function authToken() {
  const { data } = await S.sb.auth.getSession();
  return data.session ? data.session.access_token : '';
}

/* ---------- Sign-in screen ---------- */
function loginScreen(msg) {
  return new Promise((resolve) => {
    let el = $('#sf-login');
    if (!el) { el = document.createElement('div'); el.id = 'sf-login'; document.body.appendChild(el); }
    el.innerHTML = `<style>
      #sf-login{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:24px;background:radial-gradient(120% 80% at 50% 0%,#142440 0%,#080B12 60%);color:#fff;font-family:-apple-system,system-ui,sans-serif}
      #sf-login .box{width:100%;max-width:380px;display:grid;gap:14px}
      #sf-login h1{margin:0 0 4px;font-size:30px;letter-spacing:.12em;font-weight:900}
      #sf-login p{margin:0;color:#8FA9D2;line-height:1.45}
      #sf-login input{width:100%;min-height:54px;border-radius:15px;border:1px solid rgba(143,169,210,.3);background:#101D35;color:#fff;padding:0 16px;font-size:17px;box-sizing:border-box}
      #sf-login button{min-height:54px;border-radius:999px;border:0;font-weight:800;font-size:17px;cursor:pointer}
      #sf-login .go{background:linear-gradient(135deg,#00D4FF,#438BFA);color:#06101C;box-shadow:0 10px 40px -10px rgba(0,212,255,.6)}
      #sf-login .alt{background:transparent;color:#8DBBFF;min-height:44px}
      #sf-login .err{color:#FF8DA0;min-height:20px;font-size:14px}
    </style>
    <form class="box" autocomplete="on">
      <h1>STEADFAST</h1><p id="sf-l-sub">Sign in to your coach.</p>
      <input id="sf-email" type="email" placeholder="Email" autocomplete="email" required>
      <input id="sf-pass" type="password" placeholder="Password (8+ characters)" autocomplete="current-password" minlength="8" required>
      <button class="go" type="submit" id="sf-go">Sign in</button>
      <button class="alt" type="button" id="sf-mode">New here? Create your account</button>
      <div class="err" id="sf-err">${msg || ''}</div>
    </form>`;
    let create = false;
    $('#sf-mode').onclick = () => { create = !create; $('#sf-go').textContent = create ? 'Create account' : 'Sign in'; $('#sf-mode').textContent = create ? 'Have an account? Sign in' : 'New here? Create your account'; $('#sf-pass').autocomplete = create ? 'new-password' : 'current-password'; };
    el.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const email = $('#sf-email').value.trim(), password = $('#sf-pass').value;
      $('#sf-err').textContent = ''; $('#sf-go').disabled = true;
      try {
        const r = create ? await S.sb.auth.signUp({ email, password }) : await S.sb.auth.signInWithPassword({ email, password });
        if (r.error) throw r.error;
        if (!r.data.session) { $('#sf-err').textContent = 'Check your email and tap the confirm link, then come back here and sign in.'; create = false; $('#sf-go').textContent = 'Sign in'; $('#sf-mode').textContent = 'New here? Create your account'; $('#sf-pass').autocomplete = 'current-password'; }
        else { el.remove(); resolve(r.data.session.user); }
      } catch (err) { const m = err.message || 'Could not sign in.'; $('#sf-err').textContent = /invalid login/i.test(m) ? 'Wrong email or password, or this account has not been created yet. New here? Tap Create your account below.' : /not confirmed/i.test(m) ? 'Your email is not confirmed yet. Open the email from Supabase and tap the confirm link, then sign in.' : m; }
      finally { const b = $('#sf-go'); if (b) b.disabled = false; }
    };
  });
}

async function init() {
  let cfg;
  try { cfg = await loadConfig(); }
  catch (e) { S.cfgErr = e.message; console.error(e); return null; }
  S.sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: 'steadfast.auth' } });
  const { data } = await S.sb.auth.getSession();
  S.user = data.session ? data.session.user : await loginScreen();
  S.sb.auth.onAuthStateChange((ev, session) => { if (ev === 'SIGNED_OUT') location.reload(); if (session) S.user = session.user; });
  return S.user;
}

/* ---------- db: same calls the app already makes ---------- */
function dbErr(e) { const m = String((e && e.message) || e); return Object.assign(new Error(m), { code: /JWT|auth|401/i.test(m) ? 'revoked' : /quota|size|too large/i.test(m) ? 'quota_exceeded' : 'error' }); }
function snap(rows) { return { docs: rows.map(r => ({ id: r.id, data: () => r.body })) }; }
function collection() {
  const t = () => S.sb.from('docs');
  const api = {
    doc(id) {
      return {
        async set(obj) { const { error } = await t().upsert({ user_id: S.user.id, id, kind: (obj && obj.kind) || 'doc', body: obj, updated_at: new Date().toISOString() }); if (error) throw dbErr(error); },
        async delete() { const { error } = await t().delete().eq('user_id', S.user.id).eq('id', id); if (error) throw dbErr(error); },
        async get() { const { data, error } = await t().select('id,body').eq('user_id', S.user.id).eq('id', id).maybeSingle(); if (error) throw dbErr(error); return { exists: !!data, id, data: () => data && data.body }; },
      };
    },
    where(field, op, val) {
      return {
        async get() {
          if (field !== 'kind') throw new Error('only kind queries are supported');
          let q = t().select('id,body').eq('user_id', S.user.id);
          q = op === 'in' ? q.in('kind', val) : q.eq('kind', val);
          const { data, error } = await q;
          if (error) throw dbErr(error);
          return snap(data || []);
        },
      };
    },
  };
  return api;
}


/* ---------- extra coach tools in the standalone app: internet research + saving what it learns ---------- */
export const READ_TOOLS = new Set(['lookup', 'web_search', 'knowledge_search']);
/* ---------- Knowledge library: the app's own researched documents (no AI cost to search) ---------- */
async function knowledgeApi(path, body) {
  const token = await authToken();
  const r = await fetch('/api/knowledge' + (path || ''), body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) } : { headers: { Authorization: 'Bearer ' + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || ('Library unavailable (HTTP ' + r.status + ')'));
  return j;
}
const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
function personalResearch(query) {
  const SF = window.SF; if (!SF || !SF.brain) return [];
  const q = new Set(words(query)); if (!q.size) return [];
  return SF.brain().kb.map(k => ({ k, n: words(`${k.topic} ${k.tags || ''} ${k.summary} ${(k.points || []).join(' ')}`).filter(w => q.has(w)).length })).filter(x => x.n >= 2 || (x.n >= 1 && q.size <= 2)).sort((a, b) => b.n - a.n).slice(0, 3)
    .map(({ k }) => ({ topic: k.topic, summary: k.summary, points: k.points, confidence: k.confidence, updated: k.updated, status: k.verified ? 'reviewed' : 'saved from a web search (not yet verified into the library)', sources: k.sources }));
}
async function knowledgeSearch(a) {
  const query = String(a.query || '').slice(0, 500);
  const agent = (window.SF && window.SF.UI && window.SF.UI.agent) || 'main';
  let lib = { results: [] }, err = null;
  try { lib = await knowledgeApi('', { query, agent, departments: Array.isArray(a.departments) ? a.departments : undefined, limit: a.limit || 6 }); } catch (e) { err = String(e.message || e); }
  const mine = personalResearch(query);
  const results = (lib.results || []).map(r => ({ document: r.title, section: r.section, text: r.text.slice(0, 1400), evidence: `${r.evidence} = ${r.evidence_label}`, verified: r.verified, status: r.status, conflicts: r.conflicts || undefined, sources: r.sources }));
  if (!results.length && !mine.length) return { found: 0, ...(err ? { error: err } : {}), note: 'Nothing relevant in the library. If it matters, use web_search (and save_research with sources), and say this is new research rather than library knowledge.' };
  return { found: results.length + mine.length, departments: lib.departments, library: results, your_saved_research: mine.length ? mine : undefined,
    note: 'Build the answer from these documents, combined with his own data (lookup). Name the source (author/organization and year) for key claims, state the evidence level in plain words, and mention conflicts when listed. Stale or pending items: say they need re-checking. Do not add claims the documents do not support; if they do not cover part of the question, say so or use web_search for that part.' };
}
async function webSearch(query) {
  const token = await authToken();
  let r;
  try { r = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ query }) }); }
  catch (e) { return { error: 'No connection, so I could not search.' }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const why = j.message || ('Search failed (HTTP ' + r.status + (r.status === 504 ? ', timed out' : '') + ').');
    // Show the exact reason on screen so a failure can be screenshotted and fixed, not guessed at.
    try { window.SF && window.SF.toast(why.slice(0, 160)); } catch (e) {}
    window.SteadfastRuntime && window.SteadfastRuntime.audit && window.SteadfastRuntime.audit('search', 'failed', { why: why.slice(0, 400) });
    return { error: why + ' Tell Nathan the exact reason in one line; do not say the tool is down in general.' };
  }
  return { answer: j.answer, sources: j.sources, searchedAt: j.searchedAt, note: 'Answer from a live web search. Give the exact answer first, mention where it came from, and say if the evidence is weak. Do not add facts the sources do not support.' };
}
function transferTool() {
  const SF = window.SF; const keys = ['main', ...((SF && SF.TEAM) || [])];
  return { name: 'transfer_to_coach',
    description: 'Send Nathan to a teammate\'s chat, with his question, when it belongs in their lane. The teammate answers right away. Coaches: ' + keys.map(k => `${k} = ${SF.pname(k)} the ${SF.AG(k).name} (${SF.AG(k).role})`).join('; '),
    inputSchema: { type: 'object', properties: { coach: { type: 'string', enum: keys }, question: { type: 'string', description: 'His question, in his words, for the teammate.' } }, required: ['coach', 'question'] },
    execute: async (a) => {
      const k = String(a.coach || ''); if (!keys.includes(k) || k === SF.UI.agent) return { error: 'Pick a different coach.' };
      const q = String(a.question || '').slice(0, 1500);
      setTimeout(() => { location.hash = 'coach/' + k; setTimeout(() => { if (q) SF.coachSend(q); }, 700); }, 900);
      return { ok: true, note: `Sending him to ${SF.pname(k)} now. Keep your reply to one short line.` };
    } };
}
function extraTools(opts = {}) {
  return [...(opts.text && window.SF && window.SF.pname ? [transferTool()] : []),
    { name: 'knowledge_search',
      description: 'Search Steadfast\'s own research library FIRST for any substantive question: how to train or eat, why something works, what research or experts say, health and supplement questions, business, money, the Bible, discipline, communication, and expert profiles (for example Greg Plitt, Brad Schoenfeld, Eric Helms, Alex Hormozi). Returns sourced sections with evidence levels (1 strong ... 5 unsupported). It is free and fast. Searches your lane by default; pass departments to widen (physique, nutrition, health, appearance, business, wealth, faith, discipline, communication).',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The question in plain words plus key terms (for example "upper chest incline press hypertrophy").' }, departments: { type: 'array', items: { type: 'string' } } }, required: ['query'] },
      execute: async (a) => knowledgeSearch(a) },
    { name: 'web_search',
      description: 'Search the internet for a precise, current answer with sources. Use it AFTER knowledge_search when the library has nothing relevant, when the information may have changed (news, prices, laws, new studies, current events, people in the news), or when he asks for new or deeper research. Also for any factual question you are not certain about (nutrition facts, research findings, public figures, creators and athletes, their routines and claims, products, prices, rules, news, how-tos), and before saving new research. Saved notes (lookup topic "research") are a starting point, not the limit: search again for newer or better evidence whenever he asks you to look something up, when a note is old, thin or low confidence, or when the question goes beyond it. Ask one clear question per call; for a bigger question, run 2-3 searches from different angles (for example causes, what reviews say, what experts recommend). Say what is new compared with what was already saved.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The exact question to answer, with any useful detail (e.g. units, location, year).' } }, required: ['query'] },
      execute: async (a) => webSearch(String(a.query || '')) },
    { name: 'save_research',
      description: 'Save a research finding to Steadfast\'s knowledge base so every coach can use it later (lookup topic "research"). Use when Nathan asks you to learn or remember a finding, or after a web_search whose answer matters for his plan. Only save what the sources support, with their links. Updates the note if the topic already exists.',
      inputSchema: { type: 'object', properties: {
        topic: { type: 'string' }, area: { type: 'string', description: 'nutrition, training, sleep, appearance, money, faith, business, health or other' },
        summary: { type: 'string', description: '2-4 sentences, plain language, with the key numbers' },
        points: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['low', 'moderate', 'high'] },
        evidence: { type: 'number', description: '1 strong scientific/historical evidence, 2 moderate, 3 expert opinion/practical experience, 4 emerging/experimental, 5 unsupported or disputed' },
        sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } } },
        required: ['topic', 'summary', 'sources'] },
      execute: async (a) => {
        const SF = window.SF; if (!SF || !SF.brain) return { error: 'Not ready.' };
        const B = SF.brain(); const topic = String(a.topic || '').trim().slice(0, 120); if (!topic) return { error: 'Topic needed.' };
        const srcs = (Array.isArray(a.sources) ? a.sources : []).filter(x => x && x.url).slice(0, 8).map(x => ({ title: String(x.title || 'source').slice(0, 200), url: String(x.url).slice(0, 500), type: 'web' }));
        if (!srcs.length) return { error: 'Save research only with at least one source link from web_search.' };
        const id = 'kb-' + topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const note = { id, topic, area: String(a.area || 'other'), updated: new Date().toISOString().slice(0, 10), confidence: a.confidence || 'moderate', evidence: [1, 2, 3, 4, 5].includes(+a.evidence) ? +a.evidence : undefined, summary: String(a.summary || '').slice(0, 1200), points: (a.points || []).slice(0, 8).map(String), sources: srcs, by: 'web' };
        const i = B.kb.findIndex(k => k.id === id || (k.topic || '').toLowerCase() === topic.toLowerCase());
        if (i >= 0) B.kb[i] = { ...B.kb[i], ...note }; else B.kb.push(note);
        SF.touch('brain');
        return { saved: i >= 0 ? 'updated' : 'added', topic, notes: B.kb.length };
      } },
  ];
}

/* ---------- sample: Claude-runtime-compatible AI calls, backed by /api/coach ---------- */
const LIMITS = { maxPromptBytes: 900000, tools: { maxCount: 20 }, images: { maxCount: 4, mediaTypes: ['image/jpeg', 'image/png', 'image/webp'] } };
function blobToB64(b) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(b); }); }
function toContents(input) {
  if (typeof input === 'string') return [{ role: 'user', parts: [{ text: input }] }];
  return input.map(t => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(t.content || '') }] }));
}
async function callCoach(body, signal) {
  const token = await authToken();
  let r;
  try { r = await fetch('/api/coach', { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(body) }); }
  catch (e) { if (e && e.name === 'AbortError') throw { code: 'cancelled', message: 'Stopped.' }; throw { code: 'offline', message: 'No connection. Check your internet and try again.' }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { code: j.code || 'upstream_error', message: j.message || 'The coach is unavailable right now.' };
  return j;
}
async function sample(input, opts = {}) {
  const contents = toContents(input);
  if (opts.images && opts.images.length) {
    const last = [...contents].reverse().find(c => c.role === 'user');
    for (const b of opts.images.slice(0, LIMITS.images.maxCount)) last.parts.push({ inlineData: { mimeType: b.type || 'image/jpeg', data: await blobToB64(b) } });
  }
  const tools = [...(opts.tools || [])];
  if (tools.length && !tools.some(t => t.name === 'web_search')) tools.push(...extraTools({ text: true }));
  const decl = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  let text = '';
  for (let round = 0; round < 8; round++) {
    const r = await callCoach({ contents, tools: decl, deep: opts.modelTier === 'complex', json: !!opts._json }, opts.signal);
    if (r.calls && r.calls.length && tools.length) {
      contents.push({ role: 'model', parts: r.parts });
      const out = [];
      for (const c of r.calls) {
        const t = tools.find(x => x.name === c.name);
        let result;
        try { result = t ? await t.execute(c.args || {}) : { error: 'unknown tool ' + c.name }; }
        catch (e) { result = { error: String((e && e.message) || e) }; }
        // Writes: confirm the change reached the database before the coach says it's done.
        if (t && !READ_TOOLS.has(c.name) && !(result && result.error) && window.SF && window.SF.verifySaved) {
          const v = await window.SF.verifySaved();
          result = { result, saved: v.saved, ...(v.note ? { note: v.note } : {}) };
          window.SteadfastRuntime.audit('chat', c.name, { args: c.args || {}, saved: v.saved });
        }
        out.push({ functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: { result } } });
      }
      contents.push({ role: 'user', parts: out });
      if (r.text) { text = r.text; opts.onText && opts.onText({ text, delta: r.text }); }
      continue;
    }
    text = r.text || text;
    opts.onText && opts.onText({ text, delta: text });
    return { text, truncated: r.finish === 'MAX_TOKENS' };
  }
  return { text: text || 'I ran out of steps on that one. Ask me again and I will pick up where I left off.', truncated: true };
}
sample.limits = async () => LIMITS;
sample.json = async (prompt, opts = {}) => {
  const r = await sample(prompt, { ...opts, _json: true });
  const s = String(r.text || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(s); } catch { throw { code: 'bad_json', message: 'The coach returned an unreadable answer.' }; }
};

/* ---------- downloads ---------- */
const downloads = {
  async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data)], { type: 'application/octet-stream' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename || 'steadfast';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    return { status: 'saved' };
  },
};

S.ready = init();
window.claude = {
  standalone: true,
  async use(name) {
    if (name === 'sample') { await S.ready; return S.user ? sample : null; }
    if (name === 'downloads') return downloads;
    if (name === 'db') { await S.ready; return S.user ? { collection } : null; }
    if (name === 'user') { await S.ready; return S.user ? { id: async () => S.user.id, me: async () => ({ id: S.user.id, name: S.user.email }), isOwner: () => true, canEdit: () => true } : null; }
    return null; // assets, mcp, room ... not used in the standalone app
  },
};
window.SteadfastRuntime = { extraTools, READ_TOOLS, knowledge: knowledgeApi, authToken, signOut: () => S.sb && S.sb.auth.signOut(), user: () => S.user, ready: () => S.ready, configError: () => S.cfgErr, audit: async (source, action, detail) => { try { await S.sb.from('audit').insert({ user_id: S.user.id, source, action, detail }); } catch (e) {} } };
