// Search falls back to the next model when one fails, and reports each failure.
process.env.GEMINI_API_KEY = 'k';
const seen = [];
globalThis.fetch = async (url, init) => {
  const m = String(url).match(/models\/([^:]+):generateContent/); seen.push(m && m[1]);
  if (seen.length === 1) return new Response(JSON.stringify({ error: { code: 400, message: 'Search Grounding is not supported for this model.', status: 'INVALID_ARGUMENT' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Greg is a fitness creator.' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/greg', title: 'example.com' } }], webSearchQueries: ['greg'] } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const { grounded } = await import('../api/_search.js');
const r = await grounded('Who is Greg?');
const ok = seen.length === 2 && r.answer && r.sources.length === 1 && r.attempts.length === 1 && /not supported/.test(r.attempts[0].error);
console.log(ok ? '  PASS search falls back to another model when one fails (' + seen.join(' -> ') + ')' : '  FAIL search fallback ' + JSON.stringify({ seen, r }));
process.exit(ok ? 0 : 1);
