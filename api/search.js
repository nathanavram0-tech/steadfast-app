// Internet research: answers one question using Google Search grounding, and returns the sources it used.
// The coaches call this through their web_search tool. The Gemini key never leaves the server.
import { send, readJson, requireUser, missingEnv } from './_lib.js';
import { research } from './_search.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { code: 'method' });
  const miss = missingEnv(['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  if (miss.length) return send(res, 500, { code: 'not_configured', message: 'Missing settings: ' + miss.join(', ') });
  const user = await requireUser(req);
  if (!user) return send(res, 401, { code: 'not_signed_in', message: 'Sign in again.' });
  let b;
  try { b = await readJson(req); } catch { return send(res, 400, { code: 'bad_json' }); }
  const q = String(b.query || '').trim().slice(0, 1000);
  if (!q) return send(res, 400, { code: 'empty', message: 'No question.' });
  try {
    const r = await research(q);
    return send(res, 200, { ...r, searchedAt: new Date().toISOString() });
  } catch (e) {
    const at = e.attempts || [];
    console.error('search', JSON.stringify(at));
    const limited = at.length && at.every(a => a.code === 'rate_limited');
    return send(res, 502, { code: limited ? 'rate_limited' : 'search_failed', message: limited ? 'The free search limit is used up for now. It resets daily.' : 'Search failed: ' + at.map(a => a.model + ': ' + a.error).join(' | ').slice(0, 400) });
  }
}
