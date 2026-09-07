import type { SupabaseClient } from "@supabase/supabase-js";

import { classifySupabaseQueryError } from "./check.js";

export type AdminAccessStatus =
  | "authorized"
  | "error"
  | "forbidden"
  | "not_available";

export interface AdminAccessResult {
  status: AdminAccessStatus;
  code: string;
  message: string;
}

export async function checkActiveAdminAccess(
  client: SupabaseClient,
  timeoutMs = 5_000,
): Promise<AdminAccessResult> {
  try {
    const { data, error } = await client
      .from("roles")
      .select("nombre")
      .limit(1)
      .abortSignal(AbortSignal.timeout(timeoutMs));

    if (error !== null) {
      const classification = classifySupabaseQueryError(error);
      if (
        classification.status === "authentication_failed" ||
        classification.status === "permission_denied"
      ) {
        return {
          status: "forbidden",
          code: "ADMIN_ACCESS_FORBIDDEN",
          message: "La sesión no tiene permiso para consultar datos de SIBIA.",
        };
      }
      if (classification.status === "schema_missing") {
        return {
          status: "not_available",
          code: "ADMIN_ACCESS_SCHEMA_MISSING",
          message: "El esquema requerido de SIBIA no está disponible.",
        };
      }
      return {
        status: "error",
        code: "ADMIN_ACCESS_CHECK_FAILED",
        message: "Falló la comprobación de acceso a los datos de SIBIA.",
      };
    }

    if (data.length === 0) {
      return {
        status: "forbidden",
        code: "ADMIN_ROLE_NOT_AUTHORIZED",
        message:
          "La sesión está autenticada, pero no tiene acceso administrativo activo.",
      };
    }

    return {
      status: "authorized",
      code: "ADMIN_ACCESS_AUTHORIZED",
      message: "Acceso administrativo confirmado.",
    };
  } catch {
    return {
      status: "error",
      code: "ADMIN_ACCESS_CONNECTION_FAILED",
      message: "No fue posible comprobar el acceso a los datos de SIBIA.",
    };
  }
}
