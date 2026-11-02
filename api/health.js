// Setup check: tells you which settings are missing and whether the AI models are reachable.
import { GoogleGenAI } from '@google/genai';
import { send, TEXT_MODEL, LIVE_MODEL, env, missingEnv } from './_lib.js';

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
  send(res, 200, out);
}
