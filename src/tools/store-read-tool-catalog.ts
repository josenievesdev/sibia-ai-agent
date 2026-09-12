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
        "Busca productos concretos por nombre parcial o código. Tolera pequeñas variaciones tipográficas. Úsala solo cuando el usuario menciona el nombre o el código de un producto: necesita ese texto en consulta y no sirve para contar productos ni para recorrer el catálogo. Cada resultado trae coincidencia: exacta o parcial, y el resultado indica hayCoincidenciaExacta; una coincidencia parcial no confirma que el producto buscado exista. Si luego necesita stock o proveedores, usa el id devuelto para encadenar la tool específica; si hay varias coincidencias ambiguas, no elijas una al azar.",
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
        "Lista, filtra, pagina y ordena el catálogo cuando hay que ver productos concretos. Para conocer solo totales o conteos usa resumen_inventario. Úsala para conjuntos o comparaciones: catálogo, activos/inactivos, con/sin stock, mayor stock o menor stock. Para comparar por stock usa orden=stock_desc o stock_asc; por precio de venta, orden=precio_desc o precio_asc. tamanoPagina es la cantidad de productos que se devuelven: para los N primeros de un orden usa tamanoPagina=N, con una llamada por cada orden. El resultado indica total, cantidadEntregada, pagina, totalPaginas, hayMasPaginas, siguientePagina y las posiciones globales de la página, y cada producto trae stockBajo calculado con la regla real. Envía solo los argumentos que pide la petición actual: omite tamanoPagina cuando el usuario no indicó una cantidad y se usará el valor por defecto de 10, y no reutilices el tamaño, el orden, la pagina ni los filtros de una consulta anterior distinta. Solo para continuar el listado inmediatamente anterior repites sus mismos filtros, orden y tamanoPagina y pides la pagina que indique siguientePagina.",
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
            maximum: 20,
            default: 10,
            description:
              "Cantidad máxima de productos en la página. Omítelo salvo que el usuario pida una cantidad concreta en esta misma petición o estés continuando el listado anterior.",
          },
          orden: {
            type: "string",
            enum: ["nombre_asc", "stock_asc", "stock_desc", "precio_asc", "precio_desc"],
            default: "nombre_asc",
            description:
              "Orden del listado: alfabético, menor o mayor stock primero, o menor o mayor precio de venta primero.",
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
        "Obtiene conteos globales autorizados del inventario: total de productos, activos, sin stock y con stock bajo. Es la tool para saber cuántos productos hay en total o en esos estados y para resúmenes generales, aunque el usuario no use la palabra inventario. No contiene ventas, unidades vendidas, popularidad ni rotación: no la llames para responder por lo más vendido, lo más pedido o lo más demandado. No recibe argumentos.",
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
