import {
  createClient,
  type SupabaseClient,
} from "@supabase/supabase-js";

import type { SupabaseConfig } from "../../config/env.js";

export interface SupabaseConnectionOptions {
  /*
   * JWT de un usuario ya autenticado fuera de este cliente. Cada consulta
   * lo envía como Authorization para que RLS se aplique a esa identidad;
   * con esta opción `client.auth` deja de estar disponible.
   */
  accessToken?: () => Promise<string | null>;
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
    ...(options.accessToken === undefined
      ? {}
      : { accessToken: options.accessToken }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { global: { fetch: fetchWithTimeout(options.requestTimeoutMs) } }),
  });
}
