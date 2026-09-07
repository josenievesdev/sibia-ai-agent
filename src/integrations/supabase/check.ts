import type { AppConfig } from "../../config/env.js";
import type { IntegrationCheckResult } from "../check-result.js";
import { createSupabaseConnection } from "./client.js";

interface SupabaseQueryError {
  code: string;
  message: string;
}

type ClassifiedQueryError = Pick<
  IntegrationCheckResult,
  "code" | "message" | "status"
>;

const AUTHENTICATION_ERROR_CODES = new Set([
  "PGRST301",
  "PGRST302",
  "PGRST303",
]);
const MISSING_RELATION_ERROR_CODES = new Set(["42P01", "PGRST205"]);

export function classifySupabaseQueryError(
  error: SupabaseQueryError,
): ClassifiedQueryError {
  const normalizedMessage = error.message.toLowerCase();

  if (MISSING_RELATION_ERROR_CODES.has(error.code)) {
    return {
      status: "schema_missing",
      code: "SUPABASE_TABLE_MISSING",
      message:
        "Supabase respondió y aceptó la solicitud, pero public.roles todavía no existe.",
    };
  }

  if (
    AUTHENTICATION_ERROR_CODES.has(error.code) ||
    normalizedMessage.includes("invalid api key") ||
    normalizedMessage.includes("invalid jwt") ||
    normalizedMessage.includes("jwt expired")
  ) {
    return {
      status: "authentication_failed",
      code: "SUPABASE_AUTHENTICATION_FAILED",
      message:
        "Supabase respondió, pero rechazó la clave o la autenticación configurada.",
    };
  }

  if (
    error.code === "42501" ||
    error.code === "PGRST106" ||
    normalizedMessage.includes("permission denied")
  ) {
    return {
      status: "permission_denied",
      code: "SUPABASE_PERMISSION_DENIED",
      message:
        "Supabase respondió, pero la identidad configurada no tiene permiso para consultar public.roles o el esquema no está expuesto.",
    };
  }

  return {
    status: "unavailable",
    code: "SUPABASE_QUERY_FAILED",
    message:
      "Supabase respondió, pero la comprobación de public.roles falló por un error no clasificado.",
  };
}

export async function checkSupabaseSchema(
  config: AppConfig,
): Promise<IntegrationCheckResult> {
  const checkedAt = new Date().toISOString();

  if (config.supabase === null) {
    return {
      integration: "supabase",
      status: "not_configured",
      code: "SUPABASE_NOT_CONFIGURED",
      message:
        "Faltan SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY; no se intentó una conexión.",
      checkedAt,
      durationMs: 0,
      metadata: {},
    };
  }

  const startedAt = performance.now();

  try {
    const client = createSupabaseConnection(config.supabase);
    const { data, error } = await client
      .from("roles")
      .select("id_rol")
      .limit(1)
      .abortSignal(AbortSignal.timeout(config.integrationCheckTimeoutMs));

    if (error !== null) {
      const classification = classifySupabaseQueryError(error);

      return {
        integration: "supabase",
        ...classification,
        checkedAt,
        durationMs: Math.round(performance.now() - startedAt),
        metadata: {
          databaseErrorCode: error.code,
          endpointReachable: true,
        },
      };
    }

    if (data.length === 0) {
      return {
        integration: "supabase",
        status: "access_unverified",
        code: "SUPABASE_NO_VISIBLE_ROWS",
        message:
          "public.roles respondió sin errores, pero no devolvió filas; esto no prueba acceso a datos y puede significar una tabla vacía o filtrado por RLS.",
        checkedAt,
        durationMs: Math.round(performance.now() - startedAt),
        metadata: {
          endpointReachable: true,
          schemaObjectAvailable: true,
          visibleRowFound: false,
        },
      };
    }

    return {
      integration: "supabase",
      status: "available",
      code: "SUPABASE_SCHEMA_AVAILABLE",
      message:
        "Supabase respondió y se obtuvo una fila visible de public.roles con la clave configurada.",
      checkedAt,
      durationMs: Math.round(performance.now() - startedAt),
      metadata: {
        endpointReachable: true,
        schemaObjectAvailable: true,
        visibleRowFound: true,
      },
    };
  } catch (error) {
    return {
      integration: "supabase",
      status: "unavailable",
      code: "SUPABASE_CONNECTION_FAILED",
      message: "No fue posible conectar con Supabase.",
      checkedAt,
      durationMs: Math.round(performance.now() - startedAt),
      metadata: {},
    };
  }
}
