// Checks the voice token locks only the model, so each call keeps its coach prompt, tools and voice.
process.env.GEMINI_API_KEY = 'k'; process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_ANON_KEY = 'a';
let body = null;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/auth/v1/user')) return new Response(JSON.stringify({ id: 'u1', email: 'n@x.com' }), { status: 200 });
  body = JSON.parse(init.body); return new Response(JSON.stringify({ name: 'auth_tokens/x' }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const { default: handler } = await import('../api/voice-token.js');
let out; const res = { statusCode: 0, setHeader() {}, end(s) { out = s; }, status(c) { this.statusCode = c; return this; } };
await handler({ method: 'POST', headers: { authorization: 'Bearer jwt' } }, res);
const ok = body && body.fieldMask === 'model' && body.bidiGenerateContentSetup && !body.bidiGenerateContentSetup.generationConfig;
console.log(ok ? '  PASS voice token locks only the model (coach prompt, tools and voice come from the app)' : '  FAIL voice token locks more than the model: ' + JSON.stringify(body) + ' ' + out);
process.exit(ok ? 0 : 1);
