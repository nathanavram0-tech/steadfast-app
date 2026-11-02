// Explicit bridge from the app's globals to the voice module (keeps the module decoupled).
window.SF = {
  get S() { return S; }, UI, V, A, I, AGENTS, COACH_RULES,
  AG, esc, render, go, toast, chatLog, saveChat, touch,
  coachTools: (m) => [...coachTools(m), ...((window.SteadfastRuntime && window.SteadfastRuntime.extraTools) ? window.SteadfastRuntime.extraTools() : [])], coachContext, agentPrompt, teamNotes, teamSwitch,
  agentAvatar, actsHtml, mdLite, brain, logEvent, touchQuiet, getSample,
  async verifySaved() {
    for (let i = 0; i < 50 && Sync.busy; i++) await new Promise(r => setTimeout(r, 100));
    await flush();
    for (let i = 0; i < 50 && Sync.busy; i++) await new Promise(r => setTimeout(r, 100));
    if (Sync.mode !== 'cloud') return { saved: false, note: 'Saved on this phone only; cloud sync is off.' };
    if (Sync.dirty.size || Sync.error) return { saved: false, note: 'Saved on this phone; the cloud save failed and will retry.' };
    return { saved: true };
  },
};
