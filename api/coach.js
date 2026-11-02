// Text coaches: one model round per request. The app runs its own tools between rounds,
// exactly like it did inside Claude, so every coach keeps the same tools and confirmations.
import { GoogleGenAI } from '@google/genai';
import { send, readJson, requireUser, TEXT_MODEL, env, errCode, missingEnv } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { code: 'method' });
  const miss = missingEnv(['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  if (miss.length) return send(res, 500, { code: 'not_configured', message: 'Missing settings: ' + miss.join(', ') });
  const user = await requireUser(req);
  if (!user) return send(res, 401, { code: 'not_signed_in', message: 'Sign in again.' });
  let b;
  try { b = await readJson(req); } catch { return send(res, 400, { code: 'bad_json' }); }
  const contents = Array.isArray(b.contents) ? b.contents : [];
  if (!contents.length) return send(res, 400, { code: 'empty' });
  if (JSON.stringify(contents).length > 4_000_000) return send(res, 413, { code: 'too_large', message: 'Message too large.' });
  const tools = Array.isArray(b.tools) && b.tools.length
    ? [{ functionDeclarations: b.tools.slice(0, 30).map(t => ({ name: String(t.name), description: String(t.description || '').slice(0, 2000), parametersJsonSchema: t.inputSchema || { type: 'object', properties: {} } })) }]
    : undefined;
  const config = {
    ...(b.system ? { systemInstruction: String(b.system) } : {}),
    ...(tools ? { tools } : {}),
    ...(b.json ? { responseMimeType: 'application/json' } : {}),
    temperature: typeof b.temperature === 'number' ? b.temperature : 0.7,
  };
  try {
    const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
    const r = await ai.models.generateContent({ model: b.deep ? env('GEMINI_DEEP_MODEL', TEXT_MODEL()) : TEXT_MODEL(), contents, config });
    const cand = (r.candidates || [])[0] || {};
    const parts = (cand.content && cand.content.parts) || [];
    const calls = parts.filter(p => p.functionCall).map(p => ({ id: p.functionCall.id || null, name: p.functionCall.name, args: p.functionCall.args || {} }));
    const text = parts.filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
    return send(res, 200, { parts, calls, text, finish: cand.finishReason || null });
  } catch (e) {
    console.error('coach', e && e.message);
    return send(res, 502, { code: errCode(e), message: 'The coach model had a problem. Try again.' });
  }
}
