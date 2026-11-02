// Internet research: answers one question using Google Search grounding, and returns the sources it used.
// The coaches call this through their web_search tool. The Gemini key never leaves the server.
import { GoogleGenAI } from '@google/genai';
import { send, readJson, requireUser, TEXT_MODEL, env, errCode, missingEnv } from './_lib.js';

const RULES = `You are a careful research assistant for Nathan's personal coaching app.
Search the web and answer the question directly and precisely. Lead with the exact answer (a number, a date, a yes/no), then 2-5 short supporting points.
Prefer primary and high-quality sources: official sites, peer-reviewed research and systematic reviews, government and medical bodies. Say when sources disagree or evidence is weak.
Only state what the sources support. Never invent studies, numbers or citations. If you cannot find a reliable answer, say so plainly.
Health safety: do not give doses, injection schedules, stacking or cycling advice for peptides, hormones or unapproved substances; describe what the evidence and regulators say and recommend medical supervision and bloodwork. Never recommend extreme dieting, dehydration, diuretics or water cutting.`;

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
    const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
    const r = await ai.models.generateContent({
      model: env('GEMINI_SEARCH_MODEL', TEXT_MODEL()),
      contents: [{ role: 'user', parts: [{ text: `Today is ${new Date().toISOString().slice(0, 10)}.\nQuestion: ${q}` }] }],
      config: { systemInstruction: RULES, tools: [{ googleSearch: {} }], temperature: 0.2 },
    });
    const cand = (r.candidates || [])[0] || {};
    const text = ((cand.content && cand.content.parts) || []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('');
    const gm = cand.groundingMetadata || {};
    const seen = new Set();
    const sources = (gm.groundingChunks || []).map(c => c.web).filter(Boolean)
      .filter(w => w.uri && !seen.has(w.uri) && seen.add(w.uri))
      .slice(0, 8).map(w => ({ title: w.title || w.domain || 'source', url: w.uri }));
    return send(res, 200, { answer: text, sources, queries: gm.webSearchQueries || [], searchedAt: new Date().toISOString() });
  } catch (e) {
    console.error('search', e && e.message);
    return send(res, 502, { code: errCode(e), message: errCode(e) === 'rate_limited' ? 'The free search limit is used up for now. Try again later.' : 'Search had a problem. Try again.' });
  }
}
