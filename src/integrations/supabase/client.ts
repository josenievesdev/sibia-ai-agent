import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

import type { SupabaseConfig } from "../../config/env.js";

export function createSupabaseConnection(
  config: SupabaseConfig,
): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}
