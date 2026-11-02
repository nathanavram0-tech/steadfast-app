// Grounded web search with model fallback: if one model can't use Google Search right now
// (quota, not supported, outage), the next one is tried.
import { GoogleGenAI } from '@google/genai';
import { TEXT_MODEL, env, errCode, generateWithFallback } from './_lib.js';

const RULES = `You are a careful research assistant for Nathan's personal coaching app.
Search the web and answer the question directly and precisely. Lead with the exact answer (a number, a date, a yes/no), then 2-5 short supporting points.
Prefer primary and high-quality sources: official sites, peer-reviewed research and systematic reviews, government and medical bodies. Say when sources disagree or evidence is weak.
Only state what the sources support. Never invent studies, numbers or citations. If you cannot find a reliable answer, say so plainly.
Health safety: do not give doses, injection schedules, stacking or cycling advice for peptides, hormones or unapproved substances; describe what the evidence and regulators say and recommend medical supervision and bloodwork. Never recommend extreme dieting, dehydration, diuretics or water cutting.`;


export function searchModels() {
  const list = [env('GEMINI_SEARCH_MODEL', ''), TEXT_MODEL(), 'gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest'];
  return [...new Set(list.filter(Boolean))];
}

const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out after ' + ms / 1000 + 's')), ms))]);

export async function grounded(q, { budgetMs = 20000 } = {}) {
  const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
  const attempts = [];
  const until = Date.now() + budgetMs;
  for (const model of searchModels()) {
    const left = until - Date.now();
    if (left < 4000) { attempts.push({ model, error: 'skipped: out of time' }); continue; }
    try {
      const r = await timeout(ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: `Today is ${new Date().toISOString().slice(0, 10)}.\nQuestion: ${q}` }] }],
        config: { systemInstruction: RULES, tools: [{ googleSearch: {} }], temperature: 0.2 },
      }), Math.min(left, 14000), model);
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

/* ---------- Backup research path ----------
   If Google Search grounding is unavailable for this key (quota, region, plan, outage), the server
   searches the open web itself (DuckDuckGo, Bing, Wikipedia: no keys needed), reads the top pages,
   and the normal text model answers ONLY from those pages, citing them. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const decode = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
async function get(url, ms = 7000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/json' }, signal: ctl.signal, redirect: 'follow' }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
  finally { clearTimeout(t); }
}
export function parseDdg(html) {
  const out = [];
  const re = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/g;
  const hits = []; let m; while ((m = re.exec(html))) hits.push({ m, at: m.index + m[0].length });
  hits.forEach((h, i) => {
    const block = html.slice(h.at, i + 1 < hits.length ? hits[i + 1].m.index : h.at + 3000);
    const sn = block.match(/class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|td|div)>/);
    let u = h.m[1].replace(/&amp;/g, '&'); const g = u.match(/[?&]uddg=([^&]+)/); if (g) u = decodeURIComponent(g[1]); if (u.startsWith('//')) u = 'https:' + u;
    if (/^https?:/.test(u) && !/duckduckgo\.com\/y\.js|bing\.com\/aclick/.test(u)) out.push({ url: u, title: decode(h.m[2]), snippet: decode(sn && sn[1]) });
  });
  const re2 = /<a[^>]*href=["'](https?:[^"']+)["'][^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/g; // lite layout
  while ((m = re2.exec(html))) out.push({ url: m[1], title: decode(m[2]), snippet: '' });
  return out;
}
export function parseBing(html) {
  const out = []; const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
  let m; while ((m = re.exec(html))) out.push({ url: decode(m[1]), title: decode(m[2]), snippet: decode(m[3]) });
  return out;
}
export async function webResults(q) {
  const e = encodeURIComponent(q); const errors = [];
  const jobs = [
    get('https://html.duckduckgo.com/html/?q=' + e).then(parseDdg),
    get('https://www.bing.com/search?q=' + e + '&setlang=en-US').then(parseBing),
    get('https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=3&srsearch=' + e).then(t => (JSON.parse(t).query.search || []).map(x => ({ url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(x.title.replace(/ /g, '_')), title: x.title + ' (Wikipedia)', snippet: decode(x.snippet) }))),
  ];
  const names = ['duckduckgo', 'bing', 'wikipedia'];
  const settled = await Promise.allSettled(jobs);
  const seen = new Set(); const list = [];
  settled.forEach((s, i) => { if (s.status === 'fulfilled') { s.value.forEach(r => { const k = r.url.replace(/[#?].*$/, ''); if (!seen.has(k)) { seen.add(k); list.push(r); } }); if (!s.value.length) errors.push(names[i] + ': no results'); } else errors.push(names[i] + ': ' + String(s.reason && s.reason.message || s.reason).slice(0, 80)); });
  // Interleave so one engine doesn't crowd out the others.
  return { list: list.slice(0, 10), errors };
}
async function pageText(url) {
  const html = await get(url, 6000);
  return decode(html.replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')).slice(0, 6000);
}
export async function backupSearch(q) {
  const { list, errors } = await webResults(q);
  if (!list.length) { const err = new Error('backup web search found nothing (' + errors.join('; ') + ')'); throw err; }
  const top = list.slice(0, 4);
  const texts = await Promise.allSettled(top.map(r => pageText(r.url)));
  const sources = list.slice(0, 8).map((r, i) => ({ title: r.title || r.url, url: r.url, text: i < top.length && texts[i].status === 'fulfilled' ? texts[i].value : r.snippet }));
  const ctx = sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${(s.text || '').slice(0, 5000)}`).join('\n\n');
  const ai = new GoogleGenAI({ apiKey: env('GEMINI_API_KEY') });
  try {
    const { r, model, tried } = await timeout(generateWithFallback(ai, { contents: [{ role: 'user', parts: [{ text: `Today is ${new Date().toISOString().slice(0, 10)}.\nQuestion: ${q}\n\nWeb pages found just now:\n${ctx}\n\nAnswer the question using ONLY these pages. Cite them like [1], [2]. If they don't answer it, say what they do show and that you couldn't confirm the rest.` }] }], config: { systemInstruction: RULES, temperature: 0.2 } }), 30000, 'answer');
    const text = String(r.text || '').trim();
    if (!text) { const err = new Error('empty answer'); err.attempts = tried; throw err; }
    return { answer: text, sources: sources.map(({ title, url }) => ({ title, url })), queries: [q], model: 'web+' + model, attempts: tried };
  } catch (e) { const err = new Error('backup answer failed'); err.attempts = e.attempts || e.tried || [{ model: 'answer', code: errCode(e), error: String(e.message).slice(0, 200) }]; throw err; }
}
/* Google-grounded first; if that fails, the backup path. */
export async function research(q) {
  let first = [];
  if (env('GEMINI_SEARCH_GROUNDING', '') !== '1') first = [{ model: 'google-search', error: 'off (not on the free tier; set GEMINI_SEARCH_GROUNDING=1 with a paid key)' }];
  else try { return await grounded(q); } catch (e) { first = e.attempts || [{ model: 'grounded', error: String(e.message) }]; }
  try { const r = await backupSearch(q); r.attempts = [...first, ...(r.attempts || [])]; r.fallback = true; return r; }
  catch (e) { const err = new Error('All search paths failed'); err.attempts = [...first, ...(e.attempts || [{ model: 'web', error: String(e.message) }])]; throw err; }
}
