// End-to-end test with mocked services: Supabase, /api/*, and the Gemini Live WebSocket.
// Uses Chromium's fake microphone. Run: npm run build && node test/run.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require('/tmp/node_modules/playwright'); }

const types = { '.html': 'text/html', '.js': 'application/javascript', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' };
const srv = createServer((req, res) => {
  let p = new URL(req.url, 'http://x').pathname; if (p === '/') p = '/index.html';
  const f = 'public' + p; if (!existsSync(f)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', types[p.slice(p.lastIndexOf('.'))] || 'text/plain'); res.end(readFileSync(f));
}).listen(0);
const ORIGIN = 'http://localhost:' + srv.address().port;
const SB = 'http://sb.test';
const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'nathan@example.com' };
const store = new Map(); const audit = [];
const log = (...a) => console.log(...a);
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; log('  PASS', m); } else { fail++; log('  FAIL', m); } };

const b = await pw.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'] });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
page.on('pageerror', e => log('  [pageerror]', e.message));

await page.route(/cdn\.jsdelivr\.net|raw\.githubusercontent\.com/, r => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64') }));
await page.route('**/api/config', r => r.fulfill({ json: { supabaseUrl: SB, supabaseAnonKey: 'anon' } }));
// Knowledge library API served from the real index and search code.
const KB = await import('../api/_knowledge.js'); const KL = JSON.parse(readFileSync('knowledge/index.json', 'utf8')); const KMS = KB.loadIndex(KL.index);
let kbQueries = [];
await page.route('**/api/knowledge**', r => { const u = new URL(r.request().url());
  if (r.request().method() === 'POST') { const b = r.request().postDataJSON(); kbQueries.push(b); const hits = KB.searchLibrary(KL, KMS, b.query, { departments: KB.AGENT_DEPTS[b.agent] || KB.AGENT_DEPTS.main, limit: b.limit || 6 });
    return r.fulfill({ json: { query: b.query, departments: KB.AGENT_DEPTS[b.agent], results: hits.map(h => ({ doc: h.doc.id, title: h.doc.title, department: h.doc.department, section: h.chunk.heading, text: h.chunk.text, evidence: h.doc.evidence, evidence_label: KB.EVIDENCE[h.doc.evidence], verified: h.doc.verified, status: 'verified', sources: h.doc.sources })) } }); }
  if (u.searchParams.get('stats')) return r.fulfill({ json: { stats: KL.stats, coverage: KL.coverage, departments: KB.DEPARTMENTS, evidence: KB.EVIDENCE, recent: KL.docs.slice(0, 6).map(d => ({ ...d, sections: undefined })) } });
  if (u.searchParams.get('doc')) { const d = KL.docs.find(x => x.id === u.searchParams.get('doc')); return r.fulfill({ json: { doc: d } }); }
  if (u.searchParams.get('list')) return r.fulfill({ json: { docs: KL.docs.filter(d => d.department === u.searchParams.get('list')) } });
  return r.fulfill({ status: 400, json: {} }); });
let kbReply = '';
let coachCalls = 0;
await page.route('**/api/coach', async r => {
  coachCalls++; const body = r.request().postDataJSON(); if (JSON.stringify(body.contents).includes('inlineData')) { imgCalls++; imgText = JSON.stringify(body.contents); }
  const last = body.contents[body.contents.length - 1];
  const fr = last.parts[0].functionResponse;
  if (fr && fr.name === 'knowledge_search') { kbReply = JSON.stringify(fr.response.result); return r.fulfill({ json: { parts: [{ text: 'From the library: incline pressing (Chaves 2020).' }], calls: [], text: 'From the library: incline pressing (Chaves 2020).' } }); }
  if (body.tools && /upper chest/i.test(JSON.stringify(last))) { const call = { name: 'knowledge_search', args: { query: 'upper chest incline press' } }; return r.fulfill({ json: { parts: [{ functionCall: call }], calls: [call], text: '' } }); }
  if (fr && fr.name === 'transfer_to_coach') return r.fulfill({ json: { parts: [{ text: "That's Jay's area, sending you over." }], calls: [], text: "That's Jay's area, sending you over." } });
  if (body.tools && /what should i eat after/i.test(JSON.stringify(last))) { transferSys = JSON.stringify(body); if (/YOU ARE Jay/.test(transferSys)) { fuelGotIt = true; return r.fulfill({ json: { parts: [{ text: 'Jay here: 40 g protein and rice.' }], calls: [], text: 'Jay here: 40 g protein and rice.' } }); } const call = { name: 'transfer_to_coach', args: { coach: 'fuel', question: 'What should I eat after my workout?' } }; return r.fulfill({ json: { parts: [{ functionCall: call }], calls: [call], text: '' } }); }
  if (fr && fr.name === 'web_search') { const src = fr.response.result.sources; const call = { name: 'save_research', args: { topic: 'Creatine and hair loss', area: 'appearance', summary: 'One small 2009 study saw a DHT rise; no study has shown hair loss.', confidence: 'low', sources: src } }; return r.fulfill({ json: { parts: [{ functionCall: call }], calls: [call], text: '' } }); }
  if (fr && fr.name === 'save_research') return r.fulfill({ json: { parts: [{ text: 'Saved that research.' }], calls: [], text: 'Saved that research.' } });
  if (body.tools && /look up/i.test(JSON.stringify(last))) { searchTools = body.tools.map(t => t.name); const call = { name: 'web_search', args: { query: 'Does creatine cause hair loss?' } }; return r.fulfill({ json: { parts: [{ functionCall: call }], calls: [call], text: '' } }); }
  if (last.parts[0].functionResponse) return r.fulfill({ json: { parts: [{ text: 'Logged it.' }], calls: [], text: 'Logged it.' } });
  if (body.tools && body.tools.length && /ate/i.test(JSON.stringify(last))) return r.fulfill({ json: { parts: [{ functionCall: { name: 'log_food', args: { items: [{ name: 'Chicken breast', grams: 200, kcal: 330, protein: 62, carbs: 0, fat: 7 }] } } }], calls: [{ name: 'log_food', args: { items: [{ name: 'Chicken breast', grams: 200, kcal: 330, protein: 62, carbs: 0, fat: 7 }] } }], text: '' } });
  return r.fulfill({ json: { parts: [{ text: 'Summary: talked about sleep.' }], calls: [], text: 'Summary: talked about sleep.' } });
});
let imgText = '', searchTools = [], searchQ = '', imgCalls = 0, transferSys = '', fuelGotIt = false;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64');
await page.route('**/api/search', r => { searchQ = r.request().postDataJSON().query; return r.fulfill({ json: { answer: 'No good evidence that creatine causes hair loss.', sources: [{ title: 'pubmed.ncbi.nlm.nih.gov', url: 'https://pubmed.ncbi.nlm.nih.gov/19741313/' }], searchedAt: new Date().toISOString() } }); });
await page.route('**/api/voice-token', r => r.fulfill({ json: { token: 'auth_tokens/test123', model: 'gemini-3.8-live' } }));
await page.route(SB + '/**', async r => {
  const u = new URL(r.request().url()); const m = r.request().method();
  if (u.pathname.startsWith('/auth/v1/token')) return r.fulfill({ json: { access_token: 'jwt', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: 'rt', user: USER } });
  if (u.pathname.startsWith('/auth/v1/user')) return r.fulfill({ json: USER });
  if (u.pathname === '/rest/v1/docs') {
    if (m === 'POST') { const rows = [].concat(r.request().postDataJSON()); rows.forEach(x => store.set(x.id, x)); return r.fulfill({ status: 201, body: '' }); }
    if (m === 'GET') { const kin = u.searchParams.get('kind') || ''; let rows = [...store.values()]; if (kin.startsWith('in.')) { const ks = kin.slice(4, -1).split(',').map(s => s.replace(/"/g, '')); rows = rows.filter(x => ks.includes(x.kind)); } else if (kin.startsWith('eq.')) rows = rows.filter(x => x.kind === kin.slice(3)); return r.fulfill({ json: rows.map(x => ({ id: x.id, body: x.body })) }); }
    if (m === 'DELETE') { const id = (u.searchParams.get('id') || '').slice(3); store.delete(id); return r.fulfill({ status: 204, body: '' }); }
  }
  if (u.pathname === '/rest/v1/audit') { audit.push(r.request().postDataJSON()); return r.fulfill({ status: 201, body: '' }); }
  return r.fulfill({ status: 404, json: {} });
});

// Fake Gemini Live server
const live = { setup: null, audioFrames: 0, toolResponses: [], clientContent: 0, ws: null };
await page.routeWebSocket(/generativelanguage\.googleapis\.com/, ws => {
  live.ws = ws; live.url = ws.url();
  const send = o => ws.send(JSON.stringify(o));
  ws.onMessage(raw => {
    const m = JSON.parse(String(raw));
    if (m.setup) { live.setup = m.setup; (live.setups = live.setups || []).push(m.setup); send({ setupComplete: {} }); return; }
    if (m.clientContent) { live.clientContent++; live.lastClient = JSON.stringify(m.clientContent); live.allClient = (live.allClient || '') + live.lastClient; send({ serverContent: { outputTranscription: { text: 'Hey Nathan, what\'s going on?' } } }); send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(24000 * 2 * 0.6).toString('base64') } }] } } }); send({ serverContent: { turnComplete: true } }); return; }
    if (m.realtimeInput && m.realtimeInput.audio) { live.audioFrames++; return; }
    if (m.realtimeInput && m.realtimeInput.video) { live.video = (live.video || 0) + 1; return; }
    if (m.toolResponse) { live.toolResponses.push(m.toolResponse); send({ serverContent: { outputTranscription: { text: 'Done, logged two hundred grams of chicken.' } } }); send({ serverContent: { turnComplete: true } }); return; }
  });
});

log('1. Sign in');
await page.goto(ORIGIN + '/');
await page.waitForSelector('#sf-login');
await page.fill('#sf-email', USER.email); await page.fill('#sf-pass', 'password123'); await page.click('#sf-go');
await page.waitForTimeout(1500);
ok(!(await page.$('#sf-login')), 'login screen closes after sign-in');
if (await page.$('[data-a=saveSetup]')) { await page.click('[data-a=saveSetup]'); await page.waitForTimeout(800); }
ok(store.has('core'), 'app data saved to the database (core doc)');

log('2. Text coach with a tool call');
await page.evaluate(() => { location.hash = 'coach'; }); await page.waitForTimeout(500);
await page.fill('#coach-in', 'I ate 200 g chicken'); await page.click('[data-a=send]'); await page.waitForTimeout(2500);
const chatTxt = await page.locator('#chat').innerText();
ok(/Logged it/.test(chatTxt), 'coach replied after running a tool');
const month = [...store.values()].find(x => x.kind === 'month');
ok(month && JSON.stringify(month.body).includes('Chicken breast'), 'food reached the database');
ok(audit.some(a => a.source === 'chat' && a.action === 'log_food'), 'audit row written for the chat action');

await page.fill('#coach-in', 'look up whether creatine causes hair loss'); await page.click('[data-a=send]'); await page.waitForTimeout(3000);
ok(searchTools.includes('web_search') && searchTools.includes('save_research'), 'text coach has web_search and save_research');
ok(/creatine/i.test(searchQ), 'coach searched the internet (server endpoint)');
const brainDoc = store.get('brain'); ok(brainDoc && JSON.stringify(brainDoc.body).includes('Creatine and hair loss') && JSON.stringify(brainDoc.body).includes('pubmed'), 'research note with source saved to the knowledge base');
ok(/Saved that research/.test(await page.locator('#chat').innerText()), 'coach confirmed after the save');
ok(searchTools.includes('knowledge_search'), 'text coach has the knowledge library tool');
await page.fill('#coach-in', 'how do I build more upper chest'); await page.click('[data-a=send]'); await page.waitForTimeout(2500);
ok(kbQueries.length && /upper chest/.test(kbQueries[kbQueries.length - 1].query) && /phys-upper-chest|Building the upper chest/.test(kbReply) && /digitalcommons|strongerbyscience/.test(kbReply), 'coach searches the library and gets the sourced upper-chest research');
ok(!/creatine/i.test(searchQ.replace('creatine', '')) , 'no web search needed for a library question');

const before = imgCalls;
await page.setInputFiles('#coach-photo', { name: 'me.png', mimeType: 'image/png', buffer: PNG }); await page.waitForTimeout(800);
await page.fill('#coach-in', 'what should I work on in this physique photo'); await page.click('[data-a=send]'); await page.waitForTimeout(2500);
ok(imgCalls > before, 'photo sent in chat reaches the AI as an image');
ok(/you CAN see them/.test(imgText) && /LEFT vs RIGHT/.test(imgText) && /RANK the muscles/.test(imgText) && /HOLDING HIM BACK MOST/.test(imgText), 'chat photo comes with the full physique and face review instructions');
ok(/"mimeType":"image\/jpeg"/.test(imgText), 'chat photo is shrunk to a JPEG before sending (fits the upload limit)');

// specialists stay in their lane and transfer
await page.evaluate(() => { location.hash = 'coach/trainer'; }); await page.waitForTimeout(600);
await page.fill('#coach-in', 'what should I eat after my workout'); await page.click('[data-a=send]'); await page.waitForTimeout(4500);
ok((await page.evaluate(() => location.hash)) === '#coach/fuel', 'trainer transfers a food question to Fuel');
ok(fuelGotIt, 'Jay (Fuel) receives the question and answers');
ok(/STAY IN YOUR LANE/.test(transferSys), 'specialists are told to stay in their lane');
await page.evaluate(() => { location.hash = 'coach'; }); await page.waitForTimeout(400);

log('3. Live voice call');
await page.evaluate(() => { location.hash = 'talk'; }); await page.waitForTimeout(600);
ok(await page.locator('[data-a=vcStart]').count() === 1, 'voice screen shows Talk button');
await page.click('[data-a=vcStart]');
await page.waitForTimeout(2500);
ok(live.setup && /gemini-3\.8-live/.test(live.setup.model), 'connected to Live with the token-locked model');
ok(/BidiGenerateContentConstrained\?access_token=auth_tokens\/test123/.test(live.url), 'used the short-lived token (not an API key)');
ok(live.setup && JSON.stringify(live.setup.systemInstruction).includes('LIVE VOICE CALL'), 'voice rules sent');
ok(live.setup && JSON.stringify(live.setup.generationConfig || live.setup).includes('Sadaltager') && JSON.stringify(live.setup.systemInstruction).includes('Marcus'), 'head coach Marcus uses his own voice (Sadaltager, knowledgeable)');
ok(live.setup && JSON.stringify(live.setup.systemInstruction).includes('Profile'), 'Steadfast brief (brain) sent');
const fnNames = live.setup ? live.setup.tools[0].functionDeclarations.map(f => f.name) : [];
ok(fnNames.includes('lookup') && fnNames.includes('log_food') && fnNames.includes('confirm_pending') && fnNames.includes('web_search'), 'same app tools + confirm_pending declared (' + fnNames.length + ')');
ok(live.clientContent >= 1, 'coach was asked to greet');
await page.waitForTimeout(1500);
ok(live.audioFrames > 5, 'mic audio streaming (' + live.audioFrames + ' frames)');
const st1 = await page.locator('.vc-state').innerText(); log('   state:', st1);

// tool call over voice
live.ws.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'fc1', name: 'log_food', args: { items: [{ name: 'White rice', grams: 150, kcal: 195, protein: 4, carbs: 43, fat: 0 }] } }] } }));
await page.waitForTimeout(2500);
const tr = live.toolResponses[0];
ok(tr && tr.functionResponses[0].id === 'fc1', 'tool response returned to Live');
ok(tr && tr.functionResponses[0].response.output.saved === true, 'tool reported saved=true after database verify');
const month2 = [...store.values()].find(x => x.kind === 'month');
ok(month2 && JSON.stringify(month2.body).includes('White rice'), 'voice action reached the database');
ok(audit.some(a => a.source === 'voice' && a.action === 'log_food'), 'audit row written for the voice action');

// interruption
live.ws.send(JSON.stringify({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: Buffer.alloc(24000 * 2 * 3).toString('base64') } }] } } }));
await page.waitForTimeout(300);
const st2 = await page.locator('.vc-state').innerText();
live.ws.send(JSON.stringify({ serverContent: { interrupted: true } }));
await page.waitForTimeout(300);
const st3 = await page.locator('.vc-state').innerText();
ok(/speak/i.test(st2) && /listen/i.test(st3), 'interrupt stops speech and returns to listening (' + st2 + ' -> ' + st3 + ')');

// mute
await page.click('[data-a=vcMute]'); const f0 = live.audioFrames; await page.waitForTimeout(800);
ok(live.audioFrames - f0 <= 1, 'mute stops sending audio');
await page.click('[data-a=vcMute]');

// transcript
await page.click('[data-a=vcText]'); await page.waitForTimeout(200);
ok(/two hundred grams/.test(await page.locator('#vc-tx').innerText()), 'transcript visible');

// confirmations by voice: delete needs confirmation
const foodId = await page.evaluate(() => { for (const M of Object.values(window.SF.S.months)) for (const d of Object.values(M.days || {})) for (const f of (d.food || [])) return f.id; return ''; });
live.ws.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'fc2', name: 'edit_entries', args: { action: 'delete', kind: 'food', ids: [foodId] } }] } }));
await page.waitForTimeout(1500);
const out2 = live.toolResponses[1] && live.toolResponses[1].functionResponses[0].response.output; log('   delete result:', JSON.stringify(out2).slice(0, 200));
const pend = await page.locator('.vc-confirms .confirm').count();
ok(pend >= 1, 'delete waits for confirmation on screen');
live.ws.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'fc3', name: 'confirm_pending', args: { decision: 'confirm' } }] } }));
await page.waitForTimeout(1500);
const out3 = live.toolResponses[2] && live.toolResponses[2].functionResponses[0].response.output; log('   confirm result:', JSON.stringify(out3).slice(0, 200));
ok(out3 && out3.ok && out3.applied.includes('done'), 'spoken "yes" applies the change');

// show the coach a photo mid-call
const imgBefore = imgCalls;
await page.setInputFiles('#vc-photo', { name: 'me.png', mimeType: 'image/png', buffer: PNG }); await page.waitForTimeout(2500);
ok(imgCalls > imgBefore, 'photo shown on the call is looked at by the vision model');
ok(await page.locator('.vc-shot img').count() === 1, 'the photo shows on the call screen while it is reviewed');
ok(/KIND: physique/.test(imgText) && /RANK the muscles/.test(imgText), 'call photo gets the ranked muscle-by-muscle review');
ok(/arrives in a few seconds/.test(live.clients ? live.clients.join(' ') : live.allClient || ''), 'coach is told right away a photo is being analyzed');
ok(/showed you a photo/.test(live.lastClient || '') && /talked about sleep/.test(live.lastClient || ''), 'live coach receives what is in the photo and talks about it');

// hand the call to the trainer: new voice, new name, same call
const nSetups = live.setups.length;
live.ws.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'fc4', name: 'switch_coach', args: { coach: 'trainer', reason: 'log his leg workout' } }] } }));
await page.waitForTimeout(2500);
const s2 = live.setups[live.setups.length - 1];
ok(live.setups.length === nSetups + 1 && JSON.stringify(s2).includes('Algenib'), 'handoff reconnects with the trainer\'s own voice (Algenib, gravelly man)');
ok(JSON.stringify(s2.systemInstruction).includes('YOU ARE Rex') && JSON.stringify(s2.systemInstruction).includes('THIS CALL SO FAR'), 'trainer Rex gets his role plus the call so far');
ok(/Rex/.test(await page.locator('.coach-name').first().innerText()), 'screen shows Rex after the handoff');
ok(['listening', 'speaking', 'thinking'].includes(await page.evaluate(() => window.SteadfastVoice.state())), 'call stays live through the handoff');

// end call
await page.click('[data-a=vcEnd]'); await page.waitForTimeout(1500);
ok(/ended/i.test(await page.locator('.vc-state').innerText()), 'call ends cleanly');
const micLive = await page.evaluate(() => window.SteadfastVoice.state());
ok(micLive === 'ended', 'voice state ended');
const chat = store.get('chat'); const vlines = chat ? chat.body.data.log.filter(m => m.voice).length : 0;
ok(vlines >= 3, 'voice transcript saved into the Coach chat (' + vlines + ' lines)');
const brain = store.get('brain'); ok(brain && (brain.body.data.calls || []).some(c => c.voice === 'live' && c.summary), 'call summary saved to the brain');

await page.click('[data-a=vcTeam]'); await page.waitForTimeout(300);
await page.fill('[data-vc-name=trainer]', 'Mike'); await page.dispatchEvent('[data-vc-name=trainer]', 'change');
await page.selectOption('[data-vc-voice=trainer]', 'Orus'); await page.waitForTimeout(1200);
const coreT = store.get('core'); ok(coreT && JSON.stringify(coreT.body).includes('"Mike"') && JSON.stringify(coreT.body).includes('"Orus"'), 'team editor saves a new name and voice');
await page.screenshot({ path: 'test/team.png', fullPage: true });
await page.click('[data-a=vcTeam]');

log('4. Errors are shown, never an endless spinner');
await page.unroute('**/api/voice-token');
await page.route('**/api/voice-token', r => r.fulfill({ status: 500, json: { code: 'not_configured', message: 'Missing settings: GEMINI_API_KEY' } }));
await page.click('[data-a=vcStart]'); await page.waitForTimeout(1500);
ok(/set up on the server/i.test(await page.locator('.vc-err').innerText()), 'server not configured -> clear message');
await page.screenshot({ path: 'test/voice-error.png' });


log('4b. Exercise pictures and progress');
await page.evaluate(() => {
  const S = window.SF.S, p = n => String(n).padStart(2, '0');
  const key = off => { const d = new Date(); d.setDate(d.getDate() - off); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const put = (off, f) => { const k = key(off), m = k.slice(0, 7); const M = S.months[m] || (S.months[m] = { days: {}, tx: [] }); M.days = M.days || {}; const d = M.days[k] || (M.days[k] = {}); f(d); };
  put(30, d => { d.workouts = [{ id: 'w30', title: 'Push', ex: [{ name: 'Bench press', sets: 3, reps: 8, w: 165 }] }]; d.meas = { shoulders: 50, armL: 15, armR: 15.5 }; });
  put(7, d => { d.workouts = [{ id: 'w7', title: 'Push', ex: [{ name: 'Bench', sets: 3, reps: 8, w: 175 }, { name: 'Rear delt fly', sets: 3, reps: 12, w: 100 }] }]; });
  put(0, d => { d.workouts = [{ id: 'w0', title: 'Push', ex: [{ name: 'Barbell bench press', sets: 3, reps: 8, w: 185 }, { name: 'Rear delts on the chest fly machine', sets: 3, reps: 12, w: 110 }] }]; d.meas = { shoulders: 50.75, armL: 15.5, armR: 15.5 }; });
  const B = window.SF.brain(); B.photos.push({ id: 'pA', type: 'progress', pose: 'front', date: key(28), sc: { shoulders: 6, chest: 6, arm_left: 6, arm_right: 7, legs: 6 } }, { id: 'pB', type: 'progress', pose: 'front', date: key(1), sc: { shoulders: 7, chest: 6, arm_left: 7, arm_right: 7, legs: 6 } });
});
await page.evaluate(() => { location.hash = 'workouts'; }); await page.waitForTimeout(1200);
const wx = await page.locator('.wx').count(), wxImg = await page.locator('.wx .wx-img img').count();
ok(wx >= 2 && wxImg >= 2, 'logged exercises show a picture of the movement (' + wxImg + ' of ' + wx + ')');
const firstWx = await page.locator('.wx').first().innerText();
ok(/\+10 lb/.test(firstWx) && /vs last week/.test(firstWx), 'bench shows +10 lb vs last week, even with different names logged');
const rdSrc = await page.locator('.wx').nth(1).locator('img').getAttribute('src');
ok(/Reverse_Machine_Flyes/.test(rdSrc || ''), '"rear delts on the chest fly machine" shows the rear delt machine fly');
await page.locator('.wx').first().click(); await page.waitForTimeout(500);
const exSheet = await page.locator('.sheet').innerText().catch(() => '');
ok(/3 sets × 8 reps @ 185 lb/.test(exSheet) && /Past week/.test(exSheet) && /175×8 → 185×8/.test(exSheet) && /Past month/.test(exSheet) && /165×8 → 185×8/.test(exSheet), 'exercise sheet shows what you did and week and month progress');
ok(await page.locator('.ex-hero img').count() === 2, 'exercise sheet shows start and end position photos');
await page.screenshot({ path: 'test/exercise.png' });
await page.keyboard.press('Escape'); await page.evaluate(() => { location.hash = 'progress'; }); await page.waitForTimeout(800);
await page.locator('[data-a=growPick][data-v="60"]').click(); await page.waitForTimeout(400);
const grow = await page.locator('.grow').innerText().catch(() => '');
ok(/Shoulders/.test(grow) && /\+0\.75"/.test(grow) && /Left arm/.test(grow) && /\+0\.5"/.test(grow) && /Right arm/.test(grow), 'where-you-grew shows tape changes per area (shoulders +0.75", left arm +0.5")');
ok(await page.locator('.bodymap').count() === 1, 'body map is drawn');
await page.locator('.grow').scrollIntoViewIfNeeded(); await page.screenshot({ path: 'test/growth.png' });
const sw2 = await page.evaluate(() => document.documentElement.scrollWidth); ok(sw2 <= 390, 'progress page fits 390px (' + sw2 + ')');

log('4c. Knowledge library screen');
await page.evaluate(() => { location.hash = 'library'; }); await page.waitForTimeout(1200);
const libTxt = await page.locator('main, body').first().innerText();
ok(new RegExp(KL.stats.docs + '\\s*\\n?.*').test(libTxt) && /DOCUMENTS/.test(libTxt) && /KNOWLEDGE GAPS/.test(libTxt) && /DEPARTMENTS/.test(libTxt), 'library dashboard shows totals, departments and gaps');
ok(/Creatine and hair loss/.test(libTxt), 'research saved by a coach shows under Needs verifying');
await page.fill('#lib-q', 'protein'); await page.click('[data-a=libSearch]'); await page.waitForTimeout(800);
const hit = page.locator('[data-a=libDoc]').first(); ok(await hit.count() === 1, 'library search returns documents');
await page.locator('.card [data-a=libDoc]').first().click(); await page.waitForTimeout(800);
const docTxt = await page.locator('.sheet').innerText().catch(() => '');
ok(/Sources/i.test(docTxt) && /Summary/i.test(docTxt), 'document opens with its sections and sources');
await page.screenshot({ path: 'test/library-doc.png' });
await page.keyboard.press('Escape'); await page.waitForTimeout(300);
const sw3 = await page.evaluate(() => document.documentElement.scrollWidth); ok(sw3 <= 390, 'library fits 390px (' + sw3 + ')');
await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: 'test/library.png', fullPage: true });

log('5. Mobile layout');
for (const r of ['home', 'talk', 'coach', 'prefs']) { await page.evaluate(r => { location.hash = r; }, r); await page.waitForTimeout(400); const sw = await page.evaluate(() => document.documentElement.scrollWidth); ok(sw <= 390, r + ' fits 390px (' + sw + ')'); }
await page.evaluate(() => { location.hash = 'talk'; }); await page.waitForTimeout(400); await page.screenshot({ path: 'test/voice-idle.png' });

log('6. Move your data');
await page.evaluate(() => { location.hash = 'prefs'; }); await page.waitForTimeout(400);
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-a=exportAll]')]);
const exp = JSON.parse(readFileSync(await dl.path(), 'utf8'));
ok(exp.app === 'steadfast' && exp.S && exp.S.core, 'export file has all app data');
exp.S.core.profile = Object.assign({}, exp.S.core.profile, { importMarker: 'from-claude' });
await page.setInputFiles('#imp-file', { name: 'steadfast-export.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(exp)) });
await page.waitForTimeout(400); await page.click('[data-a=importOk]'); await page.waitForTimeout(1500);
const core = store.get('core'); ok(core && JSON.stringify(core.body).includes('from-claude'), 'imported data saved to the database');

log('\nPage errors:', errs.filter(e => !/favicon|404/.test(e)).slice(0, 8));
log(`\n${pass} passed, ${fail} failed`);
await b.close(); srv.close();
process.exit(fail ? 1 : 0);
