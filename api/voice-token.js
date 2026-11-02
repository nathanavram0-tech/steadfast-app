// Live voice: mints a short-lived, single-use Gemini token so the phone can open the
// live audio connection directly. The real GEMINI_API_KEY never leaves the server.
import { GoogleGenAI } from '@google/genai';
import { send, requireUser, LIVE_MODEL, env, errCode, missingEnv } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { code: 'method' });
  const miss = missingEnv(['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_ANON_KEY']);
  if (miss.length) return send(res, 500, { code: 'not_configured', message: 'Missing settings: ' + miss.join(', ') });
  const user = await requireUser(req);
  if (!user) return send(res, 401, { code: 'not_signed_in', message: 'Sign in again.' });
  try {
    const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY'), httpOptions: { apiVersion: 'v1alpha' } });
    const now = Date.now();
    const token = await ai.authTokens.create({
      config: {
        uses: 1,                                                  // one call per token
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),  // call can last up to 30 min
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(), // must start within 1 min
        liveConnectConstraints: { model: LIVE_MODEL() },          // locked to our model
        httpOptions: { apiVersion: 'v1alpha' },
      },
    });
    return send(res, 200, { token: token.name, model: LIVE_MODEL(), expiresInSec: 60 });
  } catch (e) {
    console.error('voice-token', e && e.message);
    return send(res, 502, { code: errCode(e), message: 'Could not start a voice session.' });
  }
}
