# Steadfast (standalone app)

Steadfast as its own web app, so the coach can hold a live, interruptible voice conversation inside the app.

## How it fits together

- **The app (public/)** is the same Steadfast app, served as an installable web app (PWA).
- **src/shim.js** gives the app the same storage, sign-in and AI functions it had before, backed by the services below.
- **Supabase** stores your data (table `docs`) and an audit trail (table `audit`). Row level security means only your signed-in account can read or write your rows.
- **Vercel functions (api/)** hold the Gemini key. The browser never sees it.
  - `/api/coach`: the text coach (Gemini).
  - `/api/search`: answers a question with a live Google search and returns the sources (used by the coaches' web_search tool; save_research stores findings in the knowledge base).
  - `/api/voice-token`: a single-use token that lasts a few minutes and only works for the voice model. The phone uses it to open the live voice connection directly to Google.
  - `/api/health?models=1`: shows missing settings and whether the configured models exist.
  - `/api/config`: the public Supabase URL and anon key (these are meant to be public; security comes from row level security).
- **src/voice.js** is the live voice screen. It streams the mic to Gemini Live, plays the reply, handles interruption, runs the app's own tools, checks each change reached the database before reporting success, and saves the transcript and a summary into the coach's memory.

## Setup

1. **Supabase**: open SQL Editor, paste `supabase/schema.sql`, and run it. Then copy the Project URL and the anon public key from Project Settings → API.
2. **Gemini**: create an API key at aistudio.google.com.
3. **Vercel**: import this repo and add these Environment Variables:
   - `GEMINI_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `ALLOWED_EMAILS` (optional, recommended): your email, so nobody else can use your key.
   - `GEMINI_TEXT_MODEL`, `GEMINI_LIVE_MODEL`, `GEMINI_DEEP_MODEL` (optional overrides).
4. Deploy, then open `/api/health?models=1` to confirm everything says ok.
5. Open the site on your phone, create your account, then use Share → Add to Home Screen.

## Develop

```
npm install
npm run build   # bundles src/ into public/
npm test        # end-to-end test with mocked services (Playwright)
```
