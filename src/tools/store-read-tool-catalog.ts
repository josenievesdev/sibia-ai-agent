import {
  STORE_READ_TOOL_NAMES,
  type StoreReadToolName,
  type StoreReadTools,
  type ToolStatus,
} from "./store-read-tools.js";

export interface StoreReadToolDefinition {
  type: "function";
  function: {
    name: StoreReadToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StoreToolCallResult {
  tool: string;
  status: ToolStatus;
  message: string;
  data: unknown;
  meta: Record<string, unknown>;
  error: { code: string } | null;
}

const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";

export const STORE_READ_TOOL_DEFINITIONS: readonly StoreReadToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "buscar_productos",
      description:
        "Busca productos concretos por nombre parcial o código. Tolera pequeñas variaciones tipográficas. Úsala cuando el usuario identifica, busca o menciona un producto por nombre. Si luego necesita stock o proveedores, usa el id devuelto para encadenar la tool específica; si hay varias coincidencias ambiguas, no elijas una al azar.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          consulta: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            description: "Nombre parcial o código de referencia del producto.",
          },
          limite: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            default: 10,
            description: "Máximo de coincidencias que se devolverán.",
          },
        },
        required: ["consulta"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listar_productos",
      description:
        "Lista, filtra, pagina y ordena el catálogo. Úsala para consultas sobre conjuntos o comparaciones: catálogo, activos/inactivos, con/sin stock, mayor stock o menor stock. Para máximos usa orden=stock_desc; para mínimos usa orden=stock_asc. Para rankings usa un tamanoPagina pequeño; para revisar stock bajo consulta activos ordenados por stock_asc y compara stockRegistrado con stockMinimo en los resultados.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          categoriaId: {
            type: "string",
            pattern: UUID_PATTERN,
            description:
              "UUID de categoría obtenido del usuario o de resultados reales anteriores.",
          },
          estado: {
            type: "string",
            enum: ["todos", "activo", "inactivo"],
            default: "todos",
            description: "Filtro del estado de catálogo.",
          },
          existencia: {
            type: "string",
            enum: ["todos", "con_stock", "sin_stock"],
            default: "todos",
            description:
              "Filtro separado de existencia según stock_actual registrado.",
          },
          pagina: {
            type: "integer",
            minimum: 1,
            maximum: 10000,
            default: 1,
            description: "Página solicitada.",
          },
          tamanoPagina: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 20,
            description: "Cantidad máxima de productos en la página.",
          },
          orden: {
            type: "string",
            enum: ["nombre_asc", "stock_asc", "stock_desc"],
            default: "nombre_asc",
            description:
              "Orden del listado: alfabético, menor stock primero o mayor stock primero.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consultar_stock",
      description:
        "Consulta el stock registrado, stock mínimo, estado y unidad de medida del producto seleccionado o identificado explícitamente por el usuario. No confirma cantidad vendible.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          productoId: {
            type: "string",
            pattern: UUID_PATTERN,
            description:
              "UUID escrito por el usuario o del producto ya seleccionado entre resultados reales.",
          },
        },
        required: ["productoId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "consultar_proveedores_producto",
      description:
        "Consulta proveedores asociados al producto seleccionado o identificado explícitamente por el usuario, incluyendo proveedor principal y precio de compra de referencia.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          productoId: {
            type: "string",
            pattern: UUID_PATTERN,
            description:
              "UUID escrito por el usuario o del producto ya seleccionado entre resultados reales.",
          },
          limite: {
            type: "integer",
            minimum: 1,
            maximum: 50,
            default: 20,
            description: "Máximo de proveedores que se devolverán.",
          },
        },
        required: ["productoId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resumen_inventario",
      description:
        "Obtiene conteos globales autorizados del inventario: total de productos, activos, sin stock y con stock bajo. Úsala para preguntas globales de cantidad o resumen, aunque el usuario no use exactamente la palabra inventario.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
  },
];

const STORE_READ_TOOL_NAME_SET = new Set<string>(STORE_READ_TOOL_NAMES);

export function isStoreReadToolName(value: string): value is StoreReadToolName {
  return STORE_READ_TOOL_NAME_SET.has(value);
}

function rejectedCall(
  tool: string,
  code: string,
  message: string,
): StoreToolCallResult {
  return {
    tool,
    status: "invalid_input",
    message,
    data: null,
    meta: {},
    error: { code },
  };
}

function decodeArguments(value: unknown):
  | { ok: true; value: unknown }
  | { ok: false } {
  if (typeof value !== "string") {
    return { ok: true, value: value ?? {} };
  }

  try {
    const parsed: unknown = JSON.parse(value);
    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}

export class StoreReadToolCatalog {
  readonly definitions = STORE_READ_TOOL_DEFINITIONS;

  constructor(private readonly tools: StoreReadTools) {}

  async execute(
    requestedName: string,
    rawArguments: unknown,
  ): Promise<StoreToolCallResult> {
    if (!isStoreReadToolName(requestedName)) {
      return rejectedCall(
        requestedName,
        "TOOL_NOT_REGISTERED",
        "La herramienta solicitada no está registrada en SIBIA.",
      );
    }

    const decoded = decodeArguments(rawArguments);
    if (!decoded.ok) {
      return rejectedCall(
        requestedName,
        "MALFORMED_TOOL_ARGUMENTS",
        "Los argumentos de la herramienta no contienen JSON válido.",
      );
    }

    try {
      switch (requestedName) {
        case "buscar_productos":
          return await this.tools.buscar_productos(decoded.value);
        case "listar_productos":
          return await this.tools.listar_productos(decoded.value);
        case "consultar_stock":
          return await this.tools.consultar_stock(decoded.value);
        case "consultar_proveedores_producto":
          return await this.tools.consultar_proveedores_producto(decoded.value);
        case "resumen_inventario":
          return await this.tools.resumen_inventario(decoded.value);
      }

      return rejectedCall(
        requestedName,
        "TOOL_NOT_REGISTERED",
        "La herramienta solicitada no está registrada en SIBIA.",
      );
    } catch {
      return {
        tool: requestedName,
        status: "error",
        message: "La ejecución de la herramienta falló de forma inesperada.",
        data: null,
        meta: {},
        error: { code: "TOOL_DISPATCH_FAILED" },
      };
    }
  }
}
