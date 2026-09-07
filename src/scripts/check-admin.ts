import type { SupabaseClient } from "@supabase/supabase-js";

import { ConsoleInputError } from "../console/interactive-input.js";
import {
  InteractiveSessionError,
  withInteractiveSupabaseSession,
} from "../console/interactive-supabase-session.js";
import { classifySupabaseQueryError } from "../integrations/supabase/check.js";

interface SafeResult {
  status: string;
  code: string;
  message: string;
  data?: unknown;
}

function printResult(result: SafeResult): void {
  console.log(JSON.stringify(result, null, 2));
}

function reportQueryError(
  resource: "productos" | "roles",
  error: { code: string; message: string },
): void {
  const classification = classifySupabaseQueryError(error);

  if (
    classification.status === "authentication_failed" ||
    classification.status === "permission_denied"
  ) {
    printResult({
      status: "permission_denied",
      code: "ADMIN_QUERY_PERMISSION_DENIED",
      message: `La sesión no tiene permiso para consultar public.${resource}.`,
      data: { databaseCode: error.code || "UNKNOWN" },
    });
    process.exitCode = 4;
    return;
  }

  if (classification.status === "schema_missing") {
    printResult({
      status: "query_error",
      code: "ADMIN_QUERY_TABLE_MISSING",
      message: `La tabla public.${resource} no existe.`,
      data: { databaseCode: error.code || "UNKNOWN" },
    });
    process.exitCode = 5;
    return;
  }

  printResult({
    status: "query_error",
    code: "ADMIN_QUERY_FAILED",
    message: `Falló la consulta de public.${resource}.`,
    data: { databaseCode: error.code || "UNKNOWN" },
  });
  process.exitCode = 5;
}

async function checkAdminAccess(client: SupabaseClient): Promise<void> {
  const { data: roles, error: rolesError } = await client
    .from("roles")
    .select("nombre")
    .order("nombre", { ascending: true });

  if (rolesError !== null) {
    reportQueryError("roles", rolesError);
    return;
  }

  if (roles.length === 0) {
    printResult({
      status: "permission_denied",
      code: "ADMIN_ROLE_NOT_AUTHORIZED",
      message:
        "La sesión se autenticó, pero RLS no permitió ver los roles obligatorios. Verifica que el perfil esté activo y tenga rol admin.",
    });
    process.exitCode = 4;
    return;
  }

  const { data: products, error: productsError } = await client
    .from("productos")
    .select(
      "id_producto,codigo_referencia,nombre_producto,unidad_medida,stock_actual,estado",
    )
    .order("nombre_producto", { ascending: true })
    .limit(5);

  if (productsError !== null) {
    reportQueryError("productos", productsError);
    return;
  }

  const productsAreEmpty = products.length === 0;
  printResult({
    status: productsAreEmpty ? "empty" : "ok",
    code: productsAreEmpty ? "ADMIN_PRODUCTS_EMPTY" : "ADMIN_ACCESS_VERIFIED",
    message: productsAreEmpty
      ? "Autenticación y acceso a roles correctos; no hay productos visibles."
      : "Autenticación y lectura administrativa verificadas.",
    data: {
      roles,
      products,
      productCount: products.length,
      productLimit: 5,
    },
  });
}

function reportSessionError(error: InteractiveSessionError): void {
  const resultByStatus = {
    authentication_failed: {
      status: "authentication_failed",
      code: "SUPABASE_AUTHENTICATION_FAILED",
    },
    configuration_error: {
      status: "configuration_error",
      code: "SUPABASE_CONFIGURATION_ERROR",
    },
    connection_error: {
      status: "connection_error",
      code: "SUPABASE_AUTH_CONNECTION_FAILED",
    },
    not_configured: {
      status: "configuration_error",
      code: "SUPABASE_NOT_CONFIGURED",
    },
    sign_out_error: {
      status: "sign_out_error",
      code: "SUPABASE_SIGN_OUT_FAILED",
    },
  } as const;
  const result = resultByStatus[error.code];

  printResult({ ...result, message: error.message });
  process.exitCode ||= error.exitCode;
}

try {
  await withInteractiveSupabaseSession(checkAdminAccess);
} catch (error) {
  if (error instanceof InteractiveSessionError) {
    reportSessionError(error);
  } else if (error instanceof ConsoleInputError) {
    printResult({
      status: "input_error",
      code: "CONSOLE_INPUT_ERROR",
      message: error.message,
    });
    process.exitCode = 2;
  } else {
    printResult({
      status: "connection_error",
      code: "SUPABASE_CONNECTION_FAILED",
      message: "No fue posible completar la conexión con Supabase.",
    });
    process.exitCode = 1;
  }
}
