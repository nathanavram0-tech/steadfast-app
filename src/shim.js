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
        if (!r.data.session) { $('#sf-err').textContent = 'Check your email and tap the confirm link, then come back here and sign in.'; create = false; $('#sf-go').textContent = 'Sign in'; }
        else { el.remove(); resolve(r.data.session.user); }
      } catch (err) { $('#sf-err').textContent = err.message || 'Could not sign in.'; }
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
  const tools = opts.tools || [];
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
        if (t && c.name !== 'lookup' && !(result && result.error) && window.SF && window.SF.verifySaved) {
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
window.SteadfastRuntime = { authToken, signOut: () => S.sb && S.sb.auth.signOut(), user: () => S.user, ready: () => S.ready, configError: () => S.cfgErr, audit: async (source, action, detail) => { try { await S.sb.from('audit').insert({ user_id: S.user.id, source, action, detail }); } catch (e) {} } };
