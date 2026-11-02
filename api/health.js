// Setup check: tells you which settings are missing and whether the AI models are reachable.
import { GoogleGenAI } from '@google/genai';
import { send, TEXT_MODEL, LIVE_MODEL, env, missingEnv, generateWithFallback } from './_lib.js';
import { research, backupSearch, searchModels } from './_search.js';

export default async function handler(req, res) {
  const missing = missingEnv(['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  const out = { ok: !missing.length, missing, textModel: TEXT_MODEL(), liveModel: LIVE_MODEL() };
  if (!missing.length && req.query && req.query.models === '1') {
    try {
      const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
      const names = [];
      const pager = await ai.models.list({ config: { pageSize: 200 } });
      for await (const m of pager) names.push(m.name.replace('models/', ''));
      out.models = names.filter(n => /flash|live|pro/i.test(n));
      out.textModelFound = names.includes(TEXT_MODEL());
      out.liveModelFound = names.includes(LIVE_MODEL());
    } catch (e) { out.modelsError = String(e && e.message).slice(0, 200); }
  }
  if (!missing.length && req.query && req.query.search === '1') {
    // Runs one real web search so problems show up with their exact error (no secrets in the output).
    try { const q = 'Who won the most recent Super Bowl?'; const r = req.query.backup === '1' ? await backupSearch(q) : await research(q); out.search = { ok: true, model: r.model, usedBackup: !!r.fallback || req.query.backup === '1', answer: r.answer.slice(0, 200), sources: r.sources.length, failedFirst: r.attempts }; }
    catch (e) { out.search = { ok: false, tried: searchModels(), attempts: e.attempts || String(e.message) }; }
  }
  if (!missing.length && req.query && req.query.vision === '1') {
    // Sends a tiny red test image to the text model to prove photo analysis works.
    try {
      const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';
      const { r, model, tried } = await generateWithFallback(ai, { contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: png } }, { text: 'What single color fills this image? One word.' }] }] });
      out.vision = { ok: true, model, answer: String(r.text || '').slice(0, 60), skipped: tried.map(t => t.model + ': ' + t.code) };
    } catch (e) { out.vision = { ok: false, tried: e.tried, error: String((e && e.message) || e).slice(0, 300) }; }
  }
  send(res, 200, out);
}
