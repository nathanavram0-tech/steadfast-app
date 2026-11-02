// Public, non-secret settings the app needs to reach the database (the anon key is designed to be public;
// row level security protects the data).
import { send, env } from './_lib.js';
export default function handler(req, res) {
  send(res, 200, { supabaseUrl: env('SUPABASE_URL', ''), supabaseAnonKey: env('SUPABASE_ANON_KEY', '') });
}
