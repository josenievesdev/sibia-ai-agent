import type { SupabaseClient } from "@supabase/supabase-js";

import type { SupabaseConfig } from "../../config/env.js";
import {
  createSupabaseConnection,
  type SupabaseConnectionOptions,
} from "../../integrations/supabase/client.js";

/*
 * Identidad de un usuario web ya validada por Supabase Auth. sessionId es
 * el claim session_id del JWT: identifica un inicio de sesión concreto y
 * se conserva cuando el navegador renueva el token.
 */
export interface WebIdentity {
  userId: string;
  sessionId: string | null;
}

export type WebTokenVerification =
  | { status: "valid"; identity: WebIdentity }
  | { status: "invalid" }
  | { status: "unavailable" };

export interface WebTokenVerifier {
  verify(accessToken: string): Promise<WebTokenVerification>;
}

const MAX_TOKEN_CHARACTERS = 8_192;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/*
 * Solo acepta la forma exacta `Bearer <jwt>`. La validez del token no se
 * decide aquí: la confirma Supabase Auth en cada solicitud.
 */
export function readBearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  const token = /^Bearer (\S+)$/u.exec(header.trim())?.[1];
  if (
    token === undefined ||
    token.length > MAX_TOKEN_CHARACTERS ||
    !JWT_SHAPE.test(token)
  ) {
    return null;
  }
  return token;
}

/*
 * Se lee únicamente después de que Supabase Auth aceptó el token, así que
 * el contenido ya está verificado.
 */
function sessionIdClaim(accessToken: string): string | null {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) {
    return null;
  }
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return isRecord(claims) &&
      typeof claims.session_id === "string" &&
      claims.session_id !== ""
      ? claims.session_id
      : null;
  } catch {
    return null;
  }
}

function isConnectionAuthError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const status = error.status;
  return (
    error.name === "AuthRetryableFetchError" ||
    status === 0 ||
    (typeof status === "number" && status >= 500)
  );
}

export class SupabaseWebTokenVerifier implements WebTokenVerifier {
  private readonly client: SupabaseClient;

  constructor(
    config: SupabaseConfig,
    requestTimeoutMs: number,
    createConnection: (
      config: SupabaseConfig,
      options?: SupabaseConnectionOptions,
    ) => SupabaseClient = createSupabaseConnection,
  ) {
    /*
     * Cliente sin sesión propia: solo pregunta a Supabase Auth por el JWT
     * recibido y nunca guarda tokens.
     */
    this.client = createConnection(config, { requestTimeoutMs });
  }

  async verify(accessToken: string): Promise<WebTokenVerification> {
    try {
      const { data, error } = await this.client.auth.getUser(accessToken);
      if (error !== null) {
        return isConnectionAuthError(error)
          ? { status: "unavailable" }
          : { status: "invalid" };
      }
      const userId = data.user.id;
      if (typeof userId !== "string" || userId === "") {
        return { status: "invalid" };
      }
      return {
        status: "valid",
        identity: { userId, sessionId: sessionIdClaim(accessToken) },
      };
    } catch {
      return { status: "unavailable" };
    }
  }
}
