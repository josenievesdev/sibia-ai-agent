import {
  StoreGatewayError,
  type InventorySummary,
  type ProductListItem,
  type ProductPage,
  type ProductState,
  type ProductStock,
  type ProductSuppliers,
  type StockFilter,
  type StoreGateway,
} from "../store/store-gateway.js";

export const STORE_READ_TOOL_NAMES = [
  "buscar_productos",
  "listar_productos",
  "consultar_stock",
  "consultar_proveedores_producto",
  "resumen_inventario",
] as const;

export type StoreReadToolName = (typeof STORE_READ_TOOL_NAMES)[number];
export type ToolStatus =
  | "ambiguous"
  | "empty"
  | "error"
  | "forbidden"
  | "invalid_input"
  | "not_available"
  | "ok";

export interface ToolResult<T> {
  tool: StoreReadToolName;
  status: ToolStatus;
  message: string;
  data: T | null;
  meta: Record<string, unknown>;
  error: { code: string } | null;
}

class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

function inputObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolInputError("La entrada debe ser un objeto.");
  }
  return input as Record<string, unknown>;
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowedKeys: readonly string[],
): void {
  const unknownKey = Object.keys(input).find(
    (key) => !allowedKeys.includes(key),
  );
  if (unknownKey !== undefined) {
    throw new ToolInputError(`Parámetro no permitido: ${unknownKey}.`);
  }
}

function requiredString(
  input: Record<string, unknown>,
  key: string,
  maximumLength: number,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`${key} debe ser un texto no vacío.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new ToolInputError(
      `${key} no puede superar ${maximumLength} caracteres.`,
    );
  }
  return normalized;
}

function optionalInteger(
  input: Record<string, unknown>,
  key: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const value = input[key];
  if (value === undefined) {
    return defaultValue;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new ToolInputError(
      `${key} debe ser un entero entre ${minimum} y ${maximum}.`,
    );
  }
  return value;
}

function optionalEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  allowedValues: readonly T[],
  defaultValue: T,
): T {
  const value = input[key];
  if (value === undefined || value === "") {
    return defaultValue;
  }
  if (typeof value !== "string" || !allowedValues.includes(value as T)) {
    throw new ToolInputError(
      `${key} debe ser uno de: ${allowedValues.join(", ")}.`,
    );
  }
  return value as T;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function productId(input: Record<string, unknown>): string {
  const value = requiredString(input, "productoId", 36);
  if (!UUID_PATTERN.test(value)) {
    throw new ToolInputError("productoId debe ser un UUID válido.");
  }
  return value;
}

function success<T>(
  tool: StoreReadToolName,
  data: T,
  message: string,
  meta: Record<string, unknown> = {},
): ToolResult<T> {
  return { tool, status: "ok", message, data, meta, error: null };
}

function empty<T>(
  tool: StoreReadToolName,
  data: T | null,
  message: string,
  meta: Record<string, unknown> = {},
): ToolResult<T> {
  return { tool, status: "empty", message, data, meta, error: null };
}

function failure<T>(
  tool: StoreReadToolName,
  error: unknown,
): ToolResult<T> {
  if (error instanceof ToolInputError) {
    return {
      tool,
      status: "invalid_input",
      message: error.message,
      data: null,
      meta: {},
      error: { code: "INVALID_TOOL_INPUT" },
    };
  }

  if (error instanceof StoreGatewayError) {
    const forbidden =
      error.category === "authentication_failed" ||
      error.category === "permission_denied";
    return {
      tool,
      status:
        error.category === "schema_missing"
          ? "not_available"
          : forbidden
            ? "forbidden"
            : "error",
      message: error.message,
      data: null,
      meta: {},
      error: { code: error.code },
    };
  }

  return {
    tool,
    status: "error",
    message: "La tool falló por un error no controlado.",
    data: null,
    meta: {},
    error: { code: "UNEXPECTED_TOOL_ERROR" },
  };
}

export class StoreReadTools {
  constructor(private readonly gateway: StoreGateway) {}

  async buscar_productos(input: unknown): Promise<ToolResult<ProductListItem[]>> {
    const tool = "buscar_productos";

    try {
      const parsed = inputObject(input);
      rejectUnknownKeys(parsed, ["consulta", "limite"]);
      const query = requiredString(parsed, "consulta", 100);
      const limit = optionalInteger(parsed, "limite", 10, 1, 20);
      const products = await this.gateway.searchProducts(query, limit);

      return products.length === 0
        ? empty(tool, [], "No se encontraron productos para la búsqueda.", {
            limite: limit,
          })
        : success(tool, products, "Productos encontrados.", {
            limite: limit,
            cantidad: products.length,
          });
    } catch (error) {
      return failure(tool, error);
    }
  }

  async listar_productos(input: unknown): Promise<ToolResult<ProductPage>> {
    const tool = "listar_productos";

    try {
      const parsed = inputObject(input);
      rejectUnknownKeys(parsed, [
        "categoriaId",
        "estado",
        "existencia",
        "pagina",
        "tamanoPagina",
      ]);

      let categoryId: string | undefined;
      if (parsed.categoriaId !== undefined && parsed.categoriaId !== "") {
        categoryId = requiredString(parsed, "categoriaId", 36);
        if (!UUID_PATTERN.test(categoryId)) {
          throw new ToolInputError("categoriaId debe ser un UUID válido.");
        }
      }

      const state = optionalEnum(
        parsed,
        "estado",
        ["todos", "activo", "inactivo"] as const,
        "todos",
      );
      const stock = optionalEnum(
        parsed,
        "existencia",
        ["todos", "con_stock", "sin_stock"] as const,
        "todos",
      );
      const page = optionalInteger(parsed, "pagina", 1, 1, 10_000);
      const pageSize = optionalInteger(
        parsed,
        "tamanoPagina",
        20,
        1,
        50,
      );

      const query: {
        categoriaId?: string;
        estado?: ProductState;
        existencia: StockFilter;
        pagina: number;
        tamanoPagina: number;
      } = {
        existencia: stock,
        pagina: page,
        tamanoPagina: pageSize,
      };
      if (categoryId !== undefined) {
        query.categoriaId = categoryId;
      }
      if (state !== "todos") {
        query.estado = state;
      }

      const result = await this.gateway.listProducts(query);
      const metadata = {
        pagina: result.pagina,
        tamanoPagina: result.tamanoPagina,
        total: result.total,
        totalPaginas: result.totalPaginas,
        orden: ["nombre_producto:asc", "id_producto:asc"],
      };

      return result.items.length === 0
        ? empty(tool, result, "La página solicitada no contiene productos.", metadata)
        : success(tool, result, "Productos listados.", metadata);
    } catch (error) {
      return failure(tool, error);
    }
  }

  async consultar_stock(input: unknown): Promise<ToolResult<ProductStock>> {
    const tool = "consultar_stock";

    try {
      const parsed = inputObject(input);
      rejectUnknownKeys(parsed, ["productoId"]);
      const stock = await this.gateway.getProductStock(productId(parsed));

      return stock === null
        ? empty<ProductStock>(
            tool,
            null,
            "El producto no existe o no es visible para la sesión.",
          )
        : success(
            tool,
            stock,
            "Stock registrado consultado; no representa cantidad vendible confirmada.",
          );
    } catch (error) {
      return failure(tool, error);
    }
  }

  async consultar_proveedores_producto(
    input: unknown,
  ): Promise<ToolResult<ProductSuppliers>> {
    const tool = "consultar_proveedores_producto";

    try {
      const parsed = inputObject(input);
      rejectUnknownKeys(parsed, ["productoId", "limite"]);
      const limit = optionalInteger(parsed, "limite", 20, 1, 50);
      const result = await this.gateway.getProductSuppliers(
        productId(parsed),
        limit,
      );

      if (result === null) {
        return empty<ProductSuppliers>(
          tool,
          null,
          "El producto no existe o no es visible para la sesión.",
          { limite: limit },
        );
      }

      return result.proveedores.length === 0
        ? empty(tool, result, "El producto no tiene proveedores visibles.", {
            limite: limit,
          })
        : success(tool, result, "Proveedores asociados encontrados.", {
            limite: limit,
            cantidad: result.proveedores.length,
          });
    } catch (error) {
      return failure(tool, error);
    }
  }

  async resumen_inventario(
    input: unknown = {},
  ): Promise<ToolResult<InventorySummary>> {
    const tool = "resumen_inventario";

    try {
      const parsed = inputObject(input);
      rejectUnknownKeys(parsed, []);
      const summary = await this.gateway.getInventorySummary();

      return summary.totalProductos === 0
        ? empty(
            tool,
            summary,
            "No hay productos visibles para resumir.",
            { alcance: "todos_los_registros_autorizados" },
          )
        : success(tool, summary, "Resumen de inventario calculado.", {
            alcance: "todos_los_registros_autorizados",
          });
    } catch (error) {
      return failure(tool, error);
    }
  }
}
