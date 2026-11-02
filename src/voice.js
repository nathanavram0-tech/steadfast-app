// Steadfast live voice coach.
// Phone mic -> 16 kHz PCM -> Gemini Live (WebSocket, short-lived token) -> 24 kHz speech back.
// Interruptions, turn-taking and transcripts come from the Live API. The coach uses the SAME
// prompt core, Steadfast brief, memory and tools as the text coaches (window.SF bridge).
import { GoogleGenAI, Modality } from '@google/genai';

const SF = window.SF;
const RT = window.SteadfastRuntime;
const VOICE_NAME = 'Puck';
const CONNECT_TIMEOUT_MS = 15000;

/* ---------- mic capture worklet: downsample to 16 kHz Int16, ~40 ms frames ---------- */
const WORKLET = `
class Cap extends AudioWorkletProcessor{
  constructor(){super();this.ratio=sampleRate/16000;this.buf=[];this.acc=0;this.level=0;this.n=0}
  process(inputs){const ch=inputs[0]&&inputs[0][0];if(!ch)return true;
    let sum=0;for(let i=0;i<ch.length;i++){sum+=ch[i]*ch[i];this.acc+=1;if(this.acc>=this.ratio){this.acc-=this.ratio;const s=Math.max(-1,Math.min(1,ch[i]));this.buf.push(s<0?s*0x8000:s*0x7FFF)}}
    this.level=Math.sqrt(sum/ch.length);
    if(this.buf.length>=640){const out=new Int16Array(this.buf);this.buf=[];this.port.postMessage({pcm:out.buffer,level:this.level},[out.buffer])}
    else if(++this.n%8===0)this.port.postMessage({level:this.level});
    return true}}
registerProcessor('sf-cap',Cap);`;

function b64FromBuf(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
function bufFromB64(b64) { const s = atob(b64); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; }

const C = {
  state: 'idle',        // idle | connecting | listening | thinking | speaking | paused | error | ended
  err: '', errCode: '', muted: false, showText: false,
  session: null, ctx: null, stream: null, node: null, src: null, outGain: null, outAn: null, inLevel: 0,
  playing: new Set(), nextT: 0, userLine: '', coachLine: '', msg: null, lines: [], agent: 'main',
  wake: null, timer: 0, raf: 0, startedAt: 0, closing: false, resumeHandle: null, retried: false,
};

const VOICE_RULES = `
LIVE VOICE CALL: you are on a live, hands-free voice call with Nathan. Talk like a real coach on the phone: relaxed, direct, warm. Usually 1-3 short sentences, then let him talk. Ask one sharp question when you need more info before advising. Never read lists out loud; give the top one or two things and offer more. Say numbers naturally ("about two hundred grams"). No markdown or symbols. If he interrupts, drop your point and answer the new thing. Remember everything said earlier in this call.
DATA: before answering about his numbers, call lookup. Say whether something is logged, an estimate, or not logged. Never invent data.
ACTIONS: you can change Steadfast with your tools while you talk. Only say something is saved after the tool result says it was saved. When a tool says a change needs his confirmation, tell him briefly what will change and ask "want me to do it?" When he clearly says yes, call confirm_pending with decision "confirm"; if no, "cancel".`;

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
function setState(s, err, code) { C.state = s; if (err !== undefined) { C.err = err; C.errCode = code || ''; } paint(); }
function curMsg() {
  if (!C.msg) {
    C.msg = { role: 'coach', text: '', ts: Date.now() + 1, acts: [], confirms: [], voice: true };
    SF.chatLog(C.agent).push(C.msg);
  }
  return C.msg;
}
function pushUser(text) {
  const t = String(text || '').trim(); if (!t) return;
  SF.chatLog(C.agent).push({ role: 'me', text: t, ts: Date.now(), voice: true });
  C.lines.push({ who: 'you', text: t });
}
function finishCoachTurn() {
  if (C.userLine.trim()) { pushUser(C.userLine); C.userLine = ''; }
  const t = C.coachLine.trim();
  if (t || (C.msg && ((C.msg.acts || []).length || (C.msg.confirms || []).length))) {
    const m = curMsg(); m.text = t || m.text || '…'; C.lines.push({ who: 'coach', text: m.text });
  }
  C.coachLine = ''; C.msg = null;
  SF.saveChat(); paint();
}

/* ---------- playback (24 kHz PCM from the model) ---------- */
function playPcm(b64) {
  const ctx = C.ctx; if (!ctx) return;
  const i16 = new Int16Array(bufFromB64(b64));
  const f = new Float32Array(i16.length); for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 0x8000;
  const ab = ctx.createBuffer(1, f.length, 24000); ab.copyToChannel(f, 0);
  const s = ctx.createBufferSource(); s.buffer = ab; s.connect(C.outGain);
  const t = Math.max(ctx.currentTime + 0.03, C.nextT); s.start(t); C.nextT = t + ab.duration;
  C.playing.add(s); s.onended = () => { C.playing.delete(s); if (!C.playing.size && C.state === 'speaking') setState('listening'); };
  if (C.state !== 'speaking') setState('speaking');
}
function stopPlayback() { for (const s of C.playing) { try { s.stop(); } catch (e) {} } C.playing.clear(); C.nextT = 0; }

/* ---------- tools: the same Steadfast tools, plus voice confirmation ---------- */
function toolDecls() {
  const tools = SF.coachTools({ acts: [], confirms: [] });
  const decl = tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema || { type: 'object', properties: {} } }));
  decl.push({ name: 'confirm_pending', description: 'Apply or cancel the change(s) waiting for Nathan\'s confirmation from this call. Only after he clearly says yes or no.', parametersJsonSchema: { type: 'object', properties: { decision: { type: 'string', enum: ['confirm', 'cancel'] } }, required: ['decision'] } });
  return [{ functionDeclarations: decl }];
}
function pendingConfirms() {
  const out = []; for (const m of SF.chatLog(C.agent).slice(-12)) (m.confirms || []).forEach((c, i) => { if (c.state === 'pending' && m.voice) out.push({ m, i }); });
  return out;
}
async function runTool(fc) {
  const name = fc.name, args = fc.args || {};
  if (name === 'confirm_pending') {
    const P = pendingConfirms(); if (!P.length) return { ok: false, note: 'Nothing is waiting for confirmation.' };
    for (const { m, i } of P) (args.decision === 'confirm' ? SF.A.confirmAct : SF.A.cancelAct)({ dataset: { ts: String(m.ts), i: String(i) } });
    const v = await SF.verifySaved();
    RT && RT.audit('voice', 'confirm_pending', { decision: args.decision, count: P.length, saved: v.saved });
    return { ok: true, decision: args.decision, applied: P.map(p => p.m.confirms[p.i].state), saved: v.saved, note: v.note };
  }
  const msg = curMsg();
  const t = SF.coachTools(msg).find(x => x.name === name);
  if (!t) return { error: 'Unknown tool ' + name };
  const before = (msg.acts || []).length;
  let result;
  try { result = await t.execute(args); } catch (e) { return { error: String((e && e.message) || e) }; }
  const acts = (msg.acts || []).slice(before);
  if (name !== 'lookup') {
    const v = await SF.verifySaved();
    result = { result, saved: v.saved, note: v.note, needsConfirmation: (msg.confirms || []).filter(c => c.state === 'pending').map(c => c.summary) };
    if (acts.length) RT && RT.audit('voice', name, { args, acts, saved: v.saved });
  }
  SF.saveChat(); paint();
  return result;
}

/* ---------- connect / disconnect ---------- */
async function getToken() {
  const tok = await RT.authToken();
  let r;
  try { r = await fetch('/api/voice-token', { method: 'POST', headers: { Authorization: 'Bearer ' + tok } }); }
  catch (e) { throw { code: 'offline', message: 'No internet connection.' }; }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { code: j.code || 'token', message: j.code === 'rate_limited' ? 'The free voice limit is used up for now. Try again later.' : j.code === 'not_configured' ? 'Voice isn\'t set up on the server yet (' + (j.message || '') + ').' : j.code === 'not_signed_in' ? 'Please sign in again.' : (j.message || 'Could not start the call.') };
  return j;
}

function systemText() {
  const recent = SF.chatLog('main').filter(m => m.text && !m.err).slice(-10).map(m => (m.role === 'me' ? 'Nathan: ' : 'Coach: ') + String(m.text).slice(0, 300)).join('\n');
  const calls = (SF.brain().calls || []).filter(c => c.summary).slice(-3).map(c => `${new Date(c.at).toLocaleDateString()}: ${c.summary}`).join('\n');
  return SF.agentPrompt() + SF.COACH_RULES + VOICE_RULES + '\n\n' + SF.coachContext() + SF.teamNotes()
    + (recent ? '\n\nRECENT CHAT (for continuity):\n' + recent : '') + (calls ? '\n\nEARLIER CALLS:\n' + calls : '');
}

async function connect(resumeHandle) {
  const { token, model } = await getToken();
  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
  return await ai.live.connect({
    model,
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: systemText(),
      tools: toolDecls(),
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    },
    callbacks: {
      onopen: () => {},
      onmessage: onMessage,
      onerror: (e) => { console.warn('live error', e); },
      onclose: (e) => onClose(e),
    },
  });
}

async function onMessage(m) {
  if (m.sessionResumptionUpdate && m.sessionResumptionUpdate.newHandle) C.resumeHandle = m.sessionResumptionUpdate.newHandle;
  if (m.goAway) { reconnect('goaway'); return; }
  if (m.toolCall && m.toolCall.functionCalls) {
    setState('thinking');
    const responses = [];
    for (const fc of m.toolCall.functionCalls) responses.push({ id: fc.id, name: fc.name, response: { output: await runTool(fc) } });
    try { C.session && C.session.sendToolResponse({ functionResponses: responses }); } catch (e) {}
    return;
  }
  const sc = m.serverContent; if (!sc) return;
  if (sc.interrupted) { stopPlayback(); if (C.coachLine.trim()) C.coachLine += ' —'; finishCoachTurn(); setState('listening'); }
  if (sc.inputTranscription && sc.inputTranscription.text) { C.userLine += sc.inputTranscription.text; if (C.state === 'listening') setState('thinking'); else paint(); }
  if (sc.outputTranscription && sc.outputTranscription.text) {
    if (C.userLine.trim()) { pushUser(C.userLine); C.userLine = ''; }
    C.coachLine += sc.outputTranscription.text; paint();
  }
  if (sc.modelTurn && sc.modelTurn.parts) for (const p of sc.modelTurn.parts) if (p.inlineData && p.inlineData.data) playPcm(p.inlineData.data);
  if (sc.turnComplete) finishCoachTurn();
}

function onClose(e) {
  if (C.closing || C.state === 'ended' || C.state === 'idle') return;
  if (document.visibilityState === 'hidden') { setState('paused', 'The call paused when you left the app. Tap Resume to keep going.'); return; }
  if (!C.retried) { reconnect('closed'); return; }
  setState('error', 'The call dropped. Check your connection and tap Reconnect.', 'closed');
}

async function reconnect(why) {
  C.retried = true; stopPlayback(); setState('connecting');
  try { try { C.session && C.session.close(); } catch (e) {} C.session = await withTimeout(connect(C.resumeHandle), CONNECT_TIMEOUT_MS); C.retried = why === 'goaway' ? false : C.retried; setState('listening'); }
  catch (e) { setState('error', (e && e.message) || 'Could not reconnect.', (e && e.code) || 'reconnect'); }
}

function withTimeout(p, ms) { return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej({ code: 'timeout', message: 'Connecting took too long. Check your internet and try again.' }), ms))]); }

async function start() {
  if (C.state !== 'idle' && C.state !== 'ended' && C.state !== 'error') return;
  C.agent = SF.UI.agent || 'main'; C.lines = []; C.userLine = ''; C.coachLine = ''; C.msg = null; C.err = ''; C.retried = false; C.resumeHandle = null; C.closing = false;
  setState('connecting');
  try {
    // 1) Audio must be unlocked inside the tap on iPhone.
    C.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await C.ctx.resume();
    try {
      C.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (e) {
      const denied = e && /NotAllowed|Permission|Security/i.test(e.name || e.message);
      throw { code: denied ? 'mic_denied' : 'mic_error', message: denied ? 'Microphone access is blocked. On iPhone: Settings > Safari > Microphone > Allow (or tap aA in the address bar > Website Settings > Microphone). Then try again.' : 'Couldn\'t use the microphone: ' + ((e && e.message) || 'unknown error') };
    }
    // 2) Output chain with an analyser so the orb follows the real voice.
    C.outGain = C.ctx.createGain(); C.outAn = C.ctx.createAnalyser(); C.outAn.fftSize = 512;
    C.outGain.connect(C.outAn); C.outAn.connect(C.ctx.destination);
    // 3) Mic -> worklet -> 16 kHz frames.
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await C.ctx.audioWorklet.addModule(url);
    C.src = C.ctx.createMediaStreamSource(C.stream);
    C.node = new AudioWorkletNode(C.ctx, 'sf-cap');
    C.node.port.onmessage = (ev) => {
      const d = ev.data; C.inLevel = d.level || 0;
      if (d.pcm && C.session && !C.muted && C.state !== 'paused') { try { C.session.sendRealtimeInput({ audio: { data: b64FromBuf(d.pcm), mimeType: 'audio/pcm;rate=16000' } }); } catch (e) {} }
    };
    C.src.connect(C.node);
    // 4) Live session.
    C.session = await withTimeout(connect(null), CONNECT_TIMEOUT_MS);
    C.startedAt = Date.now();
    try { C.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
    setState('listening');
    // Coach opens the call.
    C.session.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '(Nathan just started a voice call. Greet him briefly and naturally, in your own words, no stock opener.)' }] }], turnComplete: true });
    SF.logEvent('coach', 'Voice call started', { src: 'Coach' });
    loop();
  } catch (e) {
    await cleanup();
    setState('error', (e && e.message) || 'Could not start the call.', (e && e.code) || 'start');
  }
}

async function end() {
  if (C.state === 'idle' || C.state === 'ended') return;
  C.closing = true;
  if (C.coachLine || C.userLine) finishCoachTurn();
  try { C.session && C.session.close(); } catch (e) {}
  await cleanup();
  setState('ended');
  const mins = Math.max(1, Math.round((Date.now() - (C.startedAt || Date.now())) / 60000));
  const said = C.lines.map(l => (l.who === 'you' ? 'Nathan: ' : 'Coach: ') + l.text).join('\n');
  const rec = { id: 'v' + Date.now().toString(36), at: C.startedAt || Date.now(), mins, agent: C.agent, state: 'synced', voice: 'live' };
  const B = SF.brain(); B.calls = B.calls || []; B.calls.push(rec); B.calls = B.calls.slice(-30);
  SF.logEvent('coach', `Voice call (${mins} min) ended`, { src: 'Coach' });
  SF.saveChat();
  if (said.length > 40) {
    try {
      const sample = await SF.getSample();
      const r = sample && await sample(`Summarize this voice call between Nathan and his coach in at most 2 short sentences for the coach's long-term memory: decisions, commitments, how he was feeling, anything to follow up. Plain text only.\n\n${said.slice(-8000)}`, { cache: false });
      if (r && r.text) { rec.summary = r.text.trim().slice(0, 400); SF.touchQuiet('brain'); paint(); }
    } catch (e) { /* summary is optional */ }
  }
  SF.touchQuiet('brain');
}

async function cleanup() {
  cancelAnimationFrame(C.raf);
  stopPlayback();
  try { C.node && C.node.disconnect(); } catch (e) {}
  try { C.src && C.src.disconnect(); } catch (e) {}
  if (C.stream) C.stream.getTracks().forEach(t => t.stop());   // mic light goes off
  try { C.ctx && await C.ctx.close(); } catch (e) {}
  try { C.wake && await C.wake.release(); } catch (e) {}
  C.session = null; C.stream = null; C.ctx = null; C.node = null; C.src = null; C.wake = null; C.inLevel = 0;
}

function toggleMute() {
  C.muted = !C.muted;
  if (C.stream) C.stream.getAudioTracks().forEach(t => { t.enabled = !C.muted; });
  if (C.muted && C.session) { try { C.session.sendRealtimeInput({ audioStreamEnd: true }); } catch (e) {} }
  paint();
}

async function resume() {
  if (C.state !== 'paused') return;
  try { await C.ctx.resume(); } catch (e) {}
  if (!C.session) { await reconnect('resume'); return; }
  try { C.wake = await navigator.wakeLock.request('screen'); } catch (e) {}
  setState('listening');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && ['listening', 'thinking', 'speaking'].includes(C.state)) { stopPlayback(); C.state = 'paused'; C.err = 'The call paused when you left the app. Tap Resume to keep going.'; }
  if (document.visibilityState === 'visible' && C.state === 'paused') paint();
});
window.addEventListener('pagehide', () => { if (C.stream) C.stream.getTracks().forEach(t => t.stop()); });

/* ---------- audio-reactive orb ---------- */
function loop() {
  const orb = $('#vc-orb');
  if (orb) {
    let out = 0;
    if (C.outAn) { const a = new Uint8Array(C.outAn.fftSize); C.outAn.getByteTimeDomainData(a); let s = 0; for (let i = 0; i < a.length; i++) { const v = (a[i] - 128) / 128; s += v * v; } out = Math.sqrt(s / a.length); }
    const lvl = Math.min(1, (C.state === 'speaking' ? out * 4 : (C.muted ? 0 : C.inLevel * 6)));
    orb.style.setProperty('--lvl', lvl.toFixed(3));
  }
  C.raf = requestAnimationFrame(loop);
}

/* ---------- screen ---------- */
const LABEL = { idle: 'Ready', connecting: 'Connecting…', listening: 'Listening', thinking: 'Thinking…', speaking: 'Speaking', paused: 'Paused', error: 'Call problem', ended: 'Call ended' };
function coachName() { const a = SF.AG(SF.UI.agent || 'main'); return a.name === 'COACH' ? 'Coach' : a.name[0] + a.name.slice(1).toLowerCase(); }
function confirmsHtml() {
  const P = pendingConfirms(); if (!P.length) return '';
  return '<div class="vc-confirms">' + P.map(({ m, i }) => `<div class="confirm pending"><span>${SF.esc(m.confirms[i].summary)}</span><div class="row" style="gap:8px"><button class="btn sm" data-a="confirmAct" data-ts="${m.ts}" data-i="${i}">Confirm</button><button class="btn sm ghost" data-a="cancelAct" data-ts="${m.ts}" data-i="${i}">Cancel</button></div></div>`).join('') + '<p class="tiny muted" style="text-align:center;margin:0">Or just say "yes, do it".</p></div>';
}
function transcriptHtml() {
  const L = [...C.lines.slice(-12)];
  if (C.userLine.trim()) L.push({ who: 'you', text: C.userLine + '…' });
  if (C.coachLine.trim()) L.push({ who: 'coach', text: C.coachLine + '…' });
  return L.map(l => `<p class="vc-l ${l.who}"><b>${l.who === 'you' ? 'You' : coachName()}</b> ${SF.esc(l.text)}</p>`).join('') || '<p class="tiny muted">The transcript shows up here as you talk.</p>';
}
function stateBody() {
  const s = C.state, live = ['listening', 'thinking', 'speaking', 'connecting'].includes(s);
  const caption = s === 'error' || s === 'paused' ? `<p class="vc-err">${SF.esc(C.err)}</p>` : s === 'ended' ? `<p class="vc-sub">Saved to your chat with ${coachName()}. ${C.lines.length ? '' : ''}</p>` : s === 'idle' ? `<p class="vc-sub">Talk naturally and cut in anytime. ${coachName()} knows your Steadfast data and can update it for you.</p>` : s === 'listening' && C.muted ? '<p class="vc-sub">You\'re muted.</p>' : `<p class="vc-sub">${SF.esc(C.coachLine ? C.coachLine.slice(-140) : C.userLine ? C.userLine.slice(-140) : '')}</p>`;
  const main = s === 'idle' || s === 'ended'
    ? `<button class="vc-go" data-a="vcStart">${SF.I.mic}<span>${s === 'ended' ? 'Call again' : 'Talk to ' + coachName()}</span></button>`
    : s === 'error' ? `<button class="vc-go" data-a="vcStart">${SF.I.mic}<span>${C.errCode === 'closed' ? 'Reconnect' : 'Try again'}</span></button>`
    : s === 'paused' ? `<div class="vc-ctl"><button class="vc-go" data-a="vcResume"><span>Resume</span></button><button class="vc-end" data-a="vcEnd" aria-label="End call">End</button></div>`
    : `<div class="vc-ctl"><button class="vc-mute ${C.muted ? 'on' : ''}" data-a="vcMute" aria-pressed="${C.muted}" aria-label="${C.muted ? 'Unmute' : 'Mute'}">${C.muted ? 'Unmute' : 'Mute'}</button><button class="vc-end" data-a="vcEnd" aria-label="End call">End</button></div>`;
  return { live, caption, main };
}
function view() {
  const a = SF.AG(SF.UI.agent || 'main');
  const { live, caption, main } = stateBody();
  return `<div class="vc" style="--ac:${a.ac}">
    <div class="call-top"><a class="icon-btn" href="#home" aria-label="Back to home">${SF.I.back}</a><span class="coach-name" style="color:${a.ac}"><i class="live-dot ${live ? '' : 'off'}"></i>${a.name}${live ? ' · LIVE' : ''}</span><button class="icon-btn ${C.showText ? 'on' : ''}" data-a="vcText" aria-pressed="${C.showText}" aria-label="Show transcript">${SF.I.journal || SF.I.send}</button></div>
    ${live ? '' : SF.teamSwitch()}
    <div id="vc-body">${bodyHtml(caption, main)}</div>
  </div>`;
}
function bodyHtml(caption, main) {
  const a = SF.AG(SF.UI.agent || 'main');
  return `<div class="vc-stage"><div id="vc-orb" class="vc-orb s-${C.state}"><i></i><i></i><i></i><div class="vc-av">${SF.agentAvatar(SF.UI.agent || 'main', 120, 'speaker')}</div></div></div>
    <div class="vc-state s-${C.state}" role="status" aria-live="polite"><i></i>${LABEL[C.state]}</div>
    ${caption}
    ${confirmsHtml()}
    ${C.showText ? `<div class="vc-tx" id="vc-tx">${transcriptHtml()}</div>` : ''}
    ${main}
    ${C.state === 'idle' ? '<p class="vc-note">Keep the screen on during calls: iPhone pauses the mic when it locks. Headphones and AirPods work.</p>' : ''}`;
}
function paint() {
  if (SF.UI.route !== 'talk') return;
  const body = $('#vc-body');
  if (!body) { SF.render(); return; }
  const { caption, main } = stateBody();
  body.innerHTML = bodyHtml(caption, main);
  const tx = $('#vc-tx'); if (tx) tx.scrollTop = tx.scrollHeight;
  if (!C.raf && C.ctx) loop();
}

/* ---------- plug into the app ---------- */
SF.V.talk = view;
Object.assign(SF.A, {
  vcStart: () => start(),
  vcEnd: () => end(),
  vcMute: () => toggleMute(),
  vcResume: () => resume(),
  vcText: () => { C.showText = !C.showText; SF.render(); },
});
// While a call is live, a re-render (for example after Confirm) must not drop the call screen.
const css = document.createElement('style');
css.textContent = `
.vc{display:flex;flex-direction:column;gap:14px;min-height:calc(100dvh - 150px);padding-bottom:12px}
.vc-stage{display:grid;place-items:center;padding:8px 0}
.vc-orb{--lvl:0;position:relative;width:min(64vw,260px);aspect-ratio:1;display:grid;place-items:center}
.vc-orb i{position:absolute;inset:0;border-radius:50%;background:radial-gradient(circle,rgba(0,212,255,.30),rgba(67,139,250,.10) 55%,transparent 70%);transform:scale(calc(.82 + var(--lvl)*.45));transition:transform .08s linear}
.vc-orb i:nth-child(2){inset:12%;border:1px solid rgba(0,212,255,.35);background:none;transform:scale(calc(.9 + var(--lvl)*.3))}
.vc-orb i:nth-child(3){inset:24%;border:1px solid rgba(141,187,255,.25);background:none;transform:scale(calc(.95 + var(--lvl)*.2))}
.vc-orb.s-speaking i:first-child{background:radial-gradient(circle,rgba(0,212,255,.45),rgba(67,139,250,.16) 55%,transparent 70%)}
.vc-orb.s-connecting i{animation:vcSpin 1.4s linear infinite;border-top-color:#00D4FF}
.vc-orb .vc-av{position:relative;z-index:1}
@keyframes vcSpin{to{transform:rotate(360deg)}}
.vc-state{display:flex;align-items:center;justify-content:center;gap:8px;font-weight:800;font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted)}
.vc-state i{width:9px;height:9px;border-radius:50%;background:var(--muted)}
.vc-state.s-listening{color:#8DBBFF}.vc-state.s-listening i{background:#00D4FF;box-shadow:0 0 12px #00D4FF}
.vc-state.s-thinking i,.vc-state.s-connecting i{background:#438BFA;animation:aura .8s infinite}
.vc-state.s-speaking{color:#00D4FF}.vc-state.s-speaking i{background:#00D4FF;box-shadow:0 0 14px #00D4FF}
.vc-state.s-error,.vc-state.s-paused{color:#FF8DA0}.vc-state.s-error i,.vc-state.s-paused i{background:#FF3B5C}
.vc-sub{margin:0 auto;text-align:center;color:var(--muted);font-size:15px;line-height:1.45;max-width:360px;min-height:44px}
.vc-err{margin:0 auto;text-align:center;color:#FFC2CD;font-size:15px;line-height:1.45;max-width:360px;padding:12px 14px;border-radius:14px;background:rgba(255,59,92,.10);border:1px solid rgba(255,59,92,.3)}
.vc-go{display:flex;align-items:center;justify-content:center;gap:12px;min-height:64px;border-radius:999px;font-weight:800;font-size:18px;color:#06101C;background:linear-gradient(135deg,#00D4FF,var(--ac,#438BFA));box-shadow:0 10px 40px -8px rgba(0,212,255,.55);flex:1;width:100%;box-sizing:border-box}
.vc-go svg{width:26px;height:26px}
.vc-ctl{display:flex;gap:12px}
.vc-mute,.vc-end{flex:1;min-height:64px;border-radius:999px;font-weight:800;font-size:17px}
.vc-mute{background:rgba(255,255,255,.06);border:1px solid var(--line2);color:var(--text)}.vc-mute.on{background:#FFD24D;color:#1a1400;border-color:transparent}
.vc-end{background:#FF3B5C;color:#fff;box-shadow:0 10px 30px -10px rgba(255,59,92,.7)}
.vc-tx{max-height:34vh;overflow:auto;display:grid;gap:8px;padding:12px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid var(--line)}
.vc-l{margin:0;font-size:14.5px;line-height:1.45}.vc-l b{color:var(--ac,#8DBBFF);margin-right:4px}.vc-l.you b{color:var(--muted)}
.vc-confirms{display:grid;gap:8px}
.vc-note{font-size:12.5px;color:var(--muted);text-align:center;margin:0}
.live-dot.off{background:var(--muted);box-shadow:none;animation:none}
@media (prefers-reduced-motion:reduce){.vc-orb i{transition:none}.vc-orb.s-connecting i{animation:none}}`;
document.head.appendChild(css);
window.SteadfastVoice = { start, end, state: () => C.state };
if (SF.UI.route === 'talk') SF.render();
