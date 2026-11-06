import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

const options = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

/**
 * Admin client (service role). Server-side only: bypasses RLS and can
 * manage auth users. Never send this key to a client.
 */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, options);

/**
 * A fresh anon client per auth operation, so no session state is ever
 * shared between requests.
 */
export function supabasePublic() {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, options);
}
