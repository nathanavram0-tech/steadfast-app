// Search falls back to the next model when one fails, and to the backup web path when Google
// Search grounding fails for every model. Each failure is reported.
process.env.GEMINI_API_KEY = 'k';
let seen = [], mode = 'grounded';
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const DDG = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgreg.example%2Fabout&amp;rut=x">Greg Lav &amp; his training</a><a class="result__snippet" href="#">Greg is a <b>fitness</b> creator.</a></div>`;
const BING = `<li class="b_algo"><h2><a href="https://bing.example/greg" h="x">Greg on Bing</a></h2><p>Bing snippet</p></li>`;
let pages = 0, backupPrompt = '';
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = u.match(/models\/([^:]+):generateContent/);
  if (m) {
    seen.push(m[1]); const body = JSON.parse(init.body);
    if (body.tools && JSON.stringify(body.tools).includes('googleSearch')) {
      if (mode === 'allfail' || seen.length === 1) return json({ error: { code: 400, message: 'Search Grounding is not supported for this model.', status: 'INVALID_ARGUMENT' } }, 400);
      return json({ candidates: [{ content: { parts: [{ text: 'Greg is a fitness creator.' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/greg', title: 'example.com' } }], webSearchQueries: ['greg'] } }] });
    }
    backupPrompt = JSON.stringify(body.contents);
    return json({ candidates: [{ content: { parts: [{ text: 'Greg Lav is a fitness creator [1].' }] } }] });
  }
  if (u.includes('duckduckgo.com')) return new Response(DDG);
  if (u.includes('bing.com')) return new Response(BING);
  if (u.includes('wikipedia.org/w/api.php')) return json({ query: { search: [] } });
  pages++; return new Response('<html><script>x()</script><body><h1>About Greg</h1><p>Trains 5 days a week.</p></body></html>');
};
const { grounded, research, parseDdg } = await import('../api/_search.js');
let fails = 0; const check = (ok, name, info) => { console.log((ok ? '  PASS ' : '  FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(info))); if (!ok) fails++; };

const r = await grounded('Who is Greg?');
check(seen.length === 2 && r.answer && r.sources.length === 1 && r.attempts.length === 1 && /not supported/.test(r.attempts[0].error), 'search falls back to another model when one fails (' + seen.join(' -> ') + ')', { seen, r });

const d = parseDdg(DDG);
check(d.length === 1 && d[0].url === 'https://greg.example/about' && d[0].title === 'Greg Lav & his training' && d[0].snippet === 'Greg is a fitness creator.', 'DuckDuckGo results are parsed', d);

seen = []; mode = 'allfail';
const b = await research('Who is Greg Lav?');
check(b.fallback && /Greg Lav/.test(b.answer) && b.sources.some(s => s.url === 'https://greg.example/about') && b.sources.some(s => s.url === 'https://bing.example/greg') && pages >= 2 && /Trains 5 days a week/.test(backupPrompt) && !/x\(\)/.test(backupPrompt) && b.attempts.length >= 1,
  'when Google Search fails on every model, the backup web search answers from real pages', { b, pages });
process.exit(fails ? 1 : 0);
