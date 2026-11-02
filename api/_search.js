// Grounded web search with model fallback: if one model can't use Google Search right now
// (quota, not supported, outage), the next one is tried.
import { GoogleGenAI } from '@google/genai';
import { TEXT_MODEL, env, errCode } from './_lib.js';

const RULES = `You are a careful research assistant for Nathan's personal coaching app.
Search the web and answer the question directly and precisely. Lead with the exact answer (a number, a date, a yes/no), then 2-5 short supporting points.
Prefer primary and high-quality sources: official sites, peer-reviewed research and systematic reviews, government and medical bodies. Say when sources disagree or evidence is weak.
Only state what the sources support. Never invent studies, numbers or citations. If you cannot find a reliable answer, say so plainly.
Health safety: do not give doses, injection schedules, stacking or cycling advice for peptides, hormones or unapproved substances; describe what the evidence and regulators say and recommend medical supervision and bloodwork. Never recommend extreme dieting, dehydration, diuretics or water cutting.`;


export function searchModels() {
  const list = [env('GEMINI_SEARCH_MODEL', ''), TEXT_MODEL(), 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'];
  return [...new Set(list.filter(Boolean))];
}

export async function grounded(q) {
  const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
  const attempts = [];
  for (const model of searchModels()) {
    try {
      const r = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: `Today is ${new Date().toISOString().slice(0, 10)}.\nQuestion: ${q}` }] }],
        config: { systemInstruction: RULES, tools: [{ googleSearch: {} }], temperature: 0.2 },
      });
      const cand = (r.candidates || [])[0] || {};
      const text = ((cand.content && cand.content.parts) || []).filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
      if (!text) { attempts.push({ model, error: 'empty answer (' + (cand.finishReason || 'no reason') + ')' }); continue; }
      const gm = cand.groundingMetadata || {};
      const seen = new Set();
      const sources = (gm.groundingChunks || []).map(c => c.web).filter(Boolean)
        .filter(w => w.uri && !seen.has(w.uri) && seen.add(w.uri))
        .slice(0, 8).map(w => ({ title: w.title || w.domain || 'source', url: w.uri }));
      return { answer: text, sources, queries: gm.webSearchQueries || [], model, attempts };
    } catch (e) {
      attempts.push({ model, code: errCode(e), error: String((e && e.message) || e).slice(0, 300) });
    }
  }
  const err = new Error('All search models failed'); err.attempts = attempts; throw err;
}
