/*
 * Cliente HTTP del canal web. Todas las consultas empresariales pasan por
 * Fastify y el agente; este módulo solo transporta texto y el token.
 */

export type ApiErrorKind =
  | "busy"
  | "failed"
  | "forbidden"
  | "network"
  | "unauthorized"
  | "unavailable";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly code: string | null;

  constructor(kind: ApiErrorKind, code: string | null, message: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.code = code;
  }
}

export interface PublicWebConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
}

export interface AgentReply {
  status: string;
  text: string;
}

export interface SibiaApi {
  getConfig(): Promise<PublicWebConfig>;
  startSession(accessToken: string): Promise<void>;
  sendMessage(
    accessToken: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<AgentReply>;
  endSession(accessToken: string): Promise<void>;
}

interface RequestOptions {
  method: "DELETE" | "GET" | "POST";
  accessToken?: string;
  json?: unknown;
  keepalive?: boolean;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kindForStatus(status: number): ApiErrorKind {
  switch (status) {
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 429:
      return "busy";
    case 503:
      return "unavailable";
    default:
      return "failed";
  }
}

function invalidResponse(): ApiError {
  return new ApiError("failed", null, "SIBIA devolvió una respuesta inesperada.");
}

export function createApiClient(
  options: { baseUrl?: string; fetch?: typeof fetch } = {},
): SibiaApi {
  const baseUrl = options.baseUrl ?? "/api/web";
  const fetchImplementation =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));

  async function request(path: string, options: RequestOptions): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.accessToken !== undefined) {
      headers.authorization = `Bearer ${options.accessToken}`;
    }
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
    }

    let response: Response;
    try {
      response = await fetchImplementation(`${baseUrl}${path}`, {
        method: options.method,
        headers,
        cache: "no-store",
        credentials: "same-origin",
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw error;
      }
      throw new ApiError("network", null, "No fue posible conectar con SIBIA.");
    }

    const body: unknown =
      response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const code = isRecord(body) && typeof body.code === "string" ? body.code : null;
      const message =
        isRecord(body) && typeof body.message === "string"
          ? body.message
          : "SIBIA respondió con un error.";
      throw new ApiError(kindForStatus(response.status), code, message);
    }
    return body;
  }

  return {
    async getConfig() {
      const body = await request("/config", { method: "GET" });
      const supabase = isRecord(body) ? body.supabase : null;
      if (
        !isRecord(supabase) ||
        typeof supabase.url !== "string" ||
        typeof supabase.publishableKey !== "string"
      ) {
        throw invalidResponse();
      }
      return {
        supabaseUrl: supabase.url,
        supabasePublishableKey: supabase.publishableKey,
      };
    },

    async startSession(accessToken) {
      await request("/session", { method: "POST", accessToken });
    },

    async sendMessage(accessToken, message, signal) {
      const body = await request("/chat", {
        method: "POST",
        accessToken,
        json: { message },
        ...(signal === undefined ? {} : { signal }),
      });
      const reply = isRecord(body) ? body.reply : null;
      if (
        !isRecord(reply) ||
        typeof reply.text !== "string" ||
        typeof reply.status !== "string"
      ) {
        throw invalidResponse();
      }
      return { status: reply.status, text: reply.text };
    },

    async endSession(accessToken) {
      await request("/session", { method: "DELETE", accessToken, keepalive: true });
    },
  };
}
