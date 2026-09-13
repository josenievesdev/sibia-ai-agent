import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

import type { SupabaseConfig } from "../../config/env.js";

export interface SupabaseConnectionOptions {
  autoRefreshToken?: boolean;
  requestTimeoutMs?: number;
}

function fetchWithTimeout(timeoutMs: number): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const existingSignal = init?.signal;
    const signal =
      existingSignal === undefined || existingSignal === null
        ? timeoutSignal
        : AbortSignal.any([existingSignal, timeoutSignal]);
    return fetch(input, { ...init, signal });
  }) as typeof fetch;
}

export function createSupabaseConnection(
  config: SupabaseConfig,
  options: SupabaseConnectionOptions = {},
): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: options.autoRefreshToken ?? false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { global: { fetch: fetchWithTimeout(options.requestTimeoutMs) } }),
  });
}
