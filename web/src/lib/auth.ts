import type { SupabaseClient } from "@supabase/supabase-js";

import type { SibiaApi } from "./api-client";

export type SignInResult =
  | { status: "ok"; accessToken: string }
  | { status: "invalid_credentials" }
  | { status: "unavailable" };

export interface AuthService {
  signIn(email: string, password: string): Promise<SignInResult>;
  getAccessToken(): Promise<string | null>;
  signOut(): Promise<void>;
}

function isConnectionError(error: {
  name?: string | undefined;
  status?: number | undefined;
}): boolean {
  return (
    error.name === "AuthRetryableFetchError" ||
    error.status === undefined ||
    error.status === 0 ||
    error.status === 429 ||
    error.status >= 500
  );
}

/*
 * Supabase Auth en el navegador únicamente para iniciar sesión, con la URL
 * y la publishable key que entrega el backend. La sesión vive solo en
 * memoria: recargar o cerrar la página obliga a autenticarse de nuevo.
 */
export function createSupabaseAuth(api: Pick<SibiaApi, "getConfig">): AuthService {
  let client: Promise<SupabaseClient> | null = null;

  function getClient(): Promise<SupabaseClient> {
    // El SDK se descarga al primer intento de acceso, no con la página.
    client ??= Promise.all([api.getConfig(), import("@supabase/supabase-js")])
      .then(([config, { createClient }]) =>
        createClient(config.supabaseUrl, config.supabasePublishableKey, {
          auth: {
            autoRefreshToken: true,
            detectSessionInUrl: false,
            persistSession: false,
          },
        }),
      )
      .catch((error: unknown) => {
        client = null;
        throw error;
      });
    return client;
  }

  return {
    async signIn(email, password) {
      try {
        const supabase = await getClient();
        const { data, error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error !== null) {
          return isConnectionError(error)
            ? { status: "unavailable" }
            : { status: "invalid_credentials" };
        }
        const accessToken = data.session?.access_token;
        return accessToken === undefined
          ? { status: "unavailable" }
          : { status: "ok", accessToken };
      } catch {
        return { status: "unavailable" };
      }
    },

    async getAccessToken() {
      if (client === null) {
        return null;
      }
      try {
        const { data } = await (await client).auth.getSession();
        return data.session?.access_token ?? null;
      } catch {
        return null;
      }
    },

    async signOut() {
      if (client === null) {
        return;
      }
      try {
        await (await client).auth.signOut({ scope: "local" });
      } catch {
        // La sesión en memoria se descarta igualmente al cerrar la interfaz.
      }
    },
  };
}
