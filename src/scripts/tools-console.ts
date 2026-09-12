import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ConsoleInputError,
  askText,
} from "../console/interactive-input.js";
import {
  InteractiveSessionError,
  withInteractiveSupabaseSession,
} from "../console/interactive-supabase-session.js";
import type { AppConfig } from "../config/env.js";
import { checkActiveAdminAccess } from "../integrations/supabase/admin-access.js";
import { SupabaseStoreGateway } from "../store/supabase-store-gateway.js";
import { StoreReadTools } from "../tools/store-read-tools.js";

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function optionalNumber(value: string): number | undefined {
  return value === "" ? undefined : Number(value);
}

async function hasAdminAccess(
  client: SupabaseClient,
  timeoutMs: number,
): Promise<boolean> {
  const access = await checkActiveAdminAccess(client, timeoutMs);
  if (access.status !== "authorized") {
    print({
      status: access.status,
      code: access.code,
      message: access.message,
    });
    process.exitCode = access.status === "forbidden" ? 4 : 5;
    return false;
  }
  return true;
}

async function runMenu(
  client: SupabaseClient,
  config: AppConfig,
): Promise<void> {
  if (!(await hasAdminAccess(client, config.integrationCheckTimeoutMs))) {
    return;
  }

  const tools = new StoreReadTools(new SupabaseStoreGateway(client));

  while (true) {
    console.log(`
1. buscar_productos
2. listar_productos
3. consultar_stock
4. consultar_proveedores_producto
5. resumen_inventario
0. salir`);

    const option = await askText("Opción: ");

    switch (option) {
      case "1": {
        const query = await askText("Nombre parcial o código: ");
        const limit = optionalNumber(
          await askText("Límite (1-20, Enter=10): "),
        );
        print(
          await tools.buscar_productos({
            consulta: query,
            ...(limit === undefined ? {} : { limite: limit }),
          }),
        );
        break;
      }
      case "2": {
        const categoryId = await askText(
          "UUID de categoría (Enter=todas): ",
        );
        const state = await askText(
          "Estado (activo/inactivo, Enter=todos): ",
        );
        const stock = await askText(
          "Existencia (con_stock/sin_stock, Enter=todos): ",
        );
        const page = optionalNumber(await askText("Página (Enter=1): "));
        const pageSize = optionalNumber(
          await askText("Tamaño de página (1-20, Enter=10): "),
        );

        print(
          await tools.listar_productos({
            ...(categoryId === "" ? {} : { categoriaId: categoryId }),
            ...(state === "" ? {} : { estado: state }),
            ...(stock === "" ? {} : { existencia: stock }),
            ...(page === undefined ? {} : { pagina: page }),
            ...(pageSize === undefined ? {} : { tamanoPagina: pageSize }),
          }),
        );
        break;
      }
      case "3": {
        const id = await askText("UUID del producto: ");
        print(await tools.consultar_stock({ productoId: id }));
        break;
      }
      case "4": {
        const id = await askText("UUID del producto: ");
        const limit = optionalNumber(
          await askText("Límite (1-50, Enter=20): "),
        );
        print(
          await tools.consultar_proveedores_producto({
            productoId: id,
            ...(limit === undefined ? {} : { limite: limit }),
          }),
        );
        break;
      }
      case "5":
        print(await tools.resumen_inventario());
        break;
      case "0":
        console.log("Sesión finalizada.");
        return;
      default:
        console.log("Opción inválida.");
    }
  }
}

try {
  await withInteractiveSupabaseSession(runMenu);
} catch (error) {
  if (error instanceof InteractiveSessionError) {
    print({
      status: error.code,
      code: "INTERACTIVE_SESSION_ERROR",
      message: error.message,
    });
    process.exitCode ||= error.exitCode;
  } else if (error instanceof ConsoleInputError) {
    print({
      status: "input_error",
      code: "CONSOLE_INPUT_ERROR",
      message: error.message,
    });
    process.exitCode = 2;
  } else {
    print({
      status: "error",
      code: "TOOLS_CONSOLE_FAILED",
      message: "La consola de tools terminó por un error no controlado.",
    });
    process.exitCode = 1;
  }
}
