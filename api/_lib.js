// Shared server helpers. Runs only on Vercel; secrets come from environment variables.
export const env = (k, d) => process.env[k] || d;
export const TEXT_MODEL = () => env('GEMINI_TEXT_MODEL', 'gemini-3.8-flash');
export const LIVE_MODEL = () => env('GEMINI_LIVE_MODEL', 'gemini-3.8-live');

// Free-tier limits are per model, so when one model is out of quota (429) or gone (404),
// the next one answers instead. Models that just hit their limit are skipped for 10 minutes.
const DEFAULT_FALLBACKS = 'gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite';
export const textModels = (first) => [...new Set([first || TEXT_MODEL(), ...env('GEMINI_FALLBACK_MODELS', DEFAULT_FALLBACKS).split(',').map(s => s.trim()).filter(Boolean)])];
const cooling = new Map();
const signatureFree = (contents) => JSON.parse(JSON.stringify(contents), (k, v) => (k === 'thoughtSignature' ? 'skip_thought_signature_validator' : v));
export async function generateWithFallback(ai, req, { first, onSkip } = {}) {
  const tried = [];
  const models = textModels(first);
  const ready = models.filter(m => !(cooling.get(m) > Date.now()));
  for (const model of (ready.length ? ready : models)) {
    try {
      const r = await ai.models.generateContent({ ...req, model, contents: tried.length ? signatureFree(req.contents) : req.contents });
      return { r, model, tried };
    } catch (e) {
      const code = errCode(e);
      tried.push({ model, code, error: String((e && e.message) || e).slice(0, 160) });
      if (code === 'rate_limited') cooling.set(model, Date.now() + 10 * 60 * 1000);
      if (code !== 'rate_limited' && code !== 'model_not_found' && !/503|UNAVAILABLE|overloaded/i.test(String(e && e.message))) { e.tried = tried; throw e; }
      onSkip && onSkip(model, code);
    }
  }
  const err = new Error('Every AI model is out of free quota right now.'); err.tried = tried; err.code = 'rate_limited'; throw err;
}

export function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

// Confirms the caller is signed in to Steadfast (Supabase) and returns the user, or null.
export async function requireUser(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  const url = env('SUPABASE_URL'), anon = env('SUPABASE_ANON_KEY');
  if (!token || !url || !anon) return null;
  const r = await fetch(url + '/auth/v1/user', { headers: { Authorization: 'Bearer ' + token, apikey: anon } });
  if (!r.ok) return null;
  const u = await r.json();
  const allow = env('ALLOWED_EMAILS', '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (allow.length && !allow.includes(String(u.email || '').toLowerCase())) return null;
  return u;
}

export function missingEnv(keys) {
  return keys.filter(k => !process.env[k]);
}

// Map provider errors to short codes the app understands.
export function errCode(e) {
  const s = String((e && (e.status || e.code)) || '') + ' ' + String((e && e.message) || '');
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(s)) return 'rate_limited';
  if (/401|403|PERMISSION|API key/i.test(s)) return 'provider_auth';
  if (/404|not found|NOT_FOUND/i.test(s)) return 'model_not_found';
  return 'upstream_error';
}
