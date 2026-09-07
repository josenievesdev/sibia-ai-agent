import type {
  InventorySummary,
  ProductListItem,
  ProductPage,
  ProductStock,
  ProductSuppliers,
} from "../store/store-gateway.js";
import type { StoreToolCallResult } from "../tools/store-read-tool-catalog.js";

export interface GroundedToolExecution {
  name: string;
  arguments: unknown;
  result: StoreToolCallResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("es")
    .replace(/\s+/gu, " ")
    .trim();
}

function formatCop(value: number): string {
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
  }).format(value);
}

function productLabel(product: ProductListItem): string {
  return product.codigoReferencia === null
    ? product.nombre
    : `${product.nombre} (${product.codigoReferencia})`;
}

function wantsDetails(message: string): boolean {
  return /\b(?:informacion|info|datos|detalle|detalles|ficha|todo sobre)\b/u.test(
    normalize(message),
  );
}

function wantsLowStock(message: string): boolean {
  const value = normalize(message);
  return /\b(?:stock bajo|poco stock|bajo stock|stock minimo|minimo de stock|por agotarse|casi agotado|faltantes?|reabastec)\b/u.test(
    value,
  );
}

function wantsOnlyTotal(message: string): boolean {
  const value = normalize(message);
  return (
    /\b(?:cuantos|cuantas|cantidad|total)\b.*\bproductos?\b/u.test(value) ||
    /^(?:cuantos|cuantas)(?: son| hay| tenemos)?(?: en total)?$/u.test(value)
  );
}

function emptyText(execution: GroundedToolExecution): string {
  switch (execution.name) {
    case "buscar_productos":
      return "No encontré productos que coincidan con esa búsqueda.";
    case "listar_productos":
      return "No encontré productos con los filtros solicitados.";
    case "consultar_stock":
      return "No encontré ese producto o no está visible para tu sesión.";
    case "consultar_proveedores_producto": {
      const data = execution.result.data as ProductSuppliers | null;
      if (data !== null && Array.isArray(data.proveedores)) {
        return `${data.producto.nombre} no tiene proveedores visibles asociados.`;
      }
      return "No encontré ese producto o no está visible para tu sesión.";
    }
    default:
      return "No hay datos visibles para responder esa consulta.";
  }
}

function renderProductDetails(product: ProductListItem): string {
  return [
    `Información disponible de ${product.nombre}:`,
    `- Código: ${product.codigoReferencia ?? "Sin código de referencia"}`,
    `- Categoría: ${product.categoria.nombre ?? "Sin categoría visible"}`,
    `- Estado: ${product.estado}`,
    `- Unidad de medida: ${product.unidadMedida}`,
    `- Precio de venta: ${formatCop(product.precioVenta)}`,
    `- Stock registrado: ${product.stockRegistrado} ${product.unidadMedida}`,
    `- Stock mínimo: ${product.stockMinimo} ${product.unidadMedida}`,
  ].join("\n");
}

function renderSearch(message: string, data: unknown): string | null {
  if (!Array.isArray(data)) {
    return null;
  }
  const products = data as ProductListItem[];
  if (products.length === 0) {
    return "No encontré productos que coincidan con esa búsqueda.";
  }
  if (products.length === 1 && wantsDetails(message)) {
    return renderProductDetails(products[0]!);
  }

  const lines = products.slice(0, 10).map(
    (product, index) =>
      `${index + 1}. ${productLabel(product)} · ${formatCop(product.precioVenta)} · stock: ${product.stockRegistrado} ${product.unidadMedida}`,
  );
  if (products.length === 1) {
    return `Encontré ${productLabel(products[0]!)} · ${formatCop(products[0]!.precioVenta)} · stock registrado: ${products[0]!.stockRegistrado} ${products[0]!.unidadMedida}.`;
  }
  const value = normalize(message);
  const purpose = /\bstock\b/u.test(value)
    ? " para consultar su stock"
    : /\bproveedor(?:es)?\b/u.test(value)
      ? " para consultar sus proveedores"
      : "";
  return `Encontré ${products.length} coincidencias:\n${lines.join("\n")}\nIndícame cuál quieres${purpose}.`;
}

function renderLowStock(page: ProductPage): string {
  const low = page.items.filter(
    (product) =>
      product.estado === "activo" &&
      product.stockRegistrado <= product.stockMinimo,
  );
  if (low.length === 0) {
    return "No encontré productos activos cuyo stock registrado esté en o por debajo del mínimo dentro de los productos consultados.";
  }
  const lines = low.slice(0, 15).map(
    (product, index) =>
      `${index + 1}. ${productLabel(product)} · stock: ${product.stockRegistrado} ${product.unidadMedida} · mínimo: ${product.stockMinimo} ${product.unidadMedida}`,
  );
  return `Productos que requieren atención por stock bajo:\n${lines.join("\n")}`;
}

function renderPage(message: string, execution: GroundedToolExecution): string | null {
  if (!isRecord(execution.result.data) || !Array.isArray(execution.result.data.items)) {
    return null;
  }
  const page = execution.result.data as unknown as ProductPage;
  if (page.items.length === 0) {
    return "No encontré productos con los filtros solicitados.";
  }
  if (wantsLowStock(message)) {
    return renderLowStock(page);
  }

  const args = isRecord(execution.arguments) ? execution.arguments : {};
  const order = args.orden;
  const shown = page.items.slice(0, 10);
  const lines = shown.map(
    (product, index) =>
      `${index + 1}. ${productLabel(product)} · ${formatCop(product.precioVenta)} · stock: ${product.stockRegistrado} ${product.unidadMedida}`,
  );

  if (order === "stock_desc") {
    return `Productos con mayor stock registrado:\n${lines.join("\n")}`;
  }
  if (order === "stock_asc") {
    return `Productos con menor stock registrado:\n${lines.join("\n")}`;
  }

  const pageText =
    page.totalPaginas > 1 ? `Página ${page.pagina} de ${page.totalPaginas}. ` : "";
  return `${pageText}${page.total} ${page.total === 1 ? "producto" : "productos"} con estos filtros.\n${lines.join("\n")}`;
}

function renderStock(data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }
  const stock = data as unknown as ProductStock;
  return `${stock.nombre}: stock registrado ${stock.stockRegistrado} ${stock.unidadMedida}; mínimo ${stock.stockMinimo} ${stock.unidadMedida}; estado ${stock.estado}.`;
}

function renderSuppliers(data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }
  const suppliers = data as unknown as ProductSuppliers;
  if (!Array.isArray(suppliers.proveedores)) {
    return null;
  }
  if (suppliers.proveedores.length === 0) {
    return `${suppliers.producto.nombre} no tiene proveedores visibles asociados.`;
  }
  const lines = suppliers.proveedores.slice(0, 15).map((supplier, index) => {
    const principal = supplier.esPrincipal ? " · principal" : "";
    const code = supplier.codigoProveedor === null ? "" : ` · código ${supplier.codigoProveedor}`;
    return `${index + 1}. ${supplier.nombre}${principal}${code} · precio de compra de referencia: ${formatCop(supplier.precioCompraReferencia)}`;
  });
  return `Proveedores visibles de ${suppliers.producto.nombre}:\n${lines.join("\n")}`;
}

function renderSummary(message: string, data: unknown): string | null {
  if (!isRecord(data)) {
    return null;
  }
  const summary = data as unknown as InventorySummary;
  if (wantsOnlyTotal(message)) {
    return `Tenemos ${summary.totalProductos} productos registrados.`;
  }
  return `Resumen del inventario: ${summary.totalProductos} productos registrados; ${summary.productosActivos} activos; ${summary.productosSinStock} sin stock; ${summary.productosConStockBajo} activos con stock registrado en o por debajo del mínimo.`;
}

export function renderGroundedResponse(
  message: string,
  executions: readonly GroundedToolExecution[],
): string {
  const completed = executions.filter(
    (execution) => execution.result.status !== "invalid_input",
  );
  if (completed.length === 0) {
    return "No pude completar una consulta válida con esos datos. Prueba indicando el producto o la consulta de otra forma.";
  }

  if (completed.some((execution) => execution.result.status === "forbidden")) {
    return "Tu sesión no tiene permiso para realizar esa consulta.";
  }
  if (completed.some((execution) => execution.result.status === "not_available")) {
    return "La información necesaria todavía no está disponible en esta instalación de SIBIA.";
  }
  if (completed.some((execution) => execution.result.status === "error")) {
    return "La consulta falló por un problema técnico.";
  }

  const last = completed.at(-1)!;
  if (last.result.status === "empty") {
    return emptyText(last);
  }

  let rendered: string | null = null;
  switch (last.name) {
    case "buscar_productos":
      rendered = renderSearch(message, last.result.data);
      break;
    case "listar_productos":
      rendered = renderPage(message, last);
      break;
    case "consultar_stock":
      rendered = renderStock(last.result.data);
      break;
    case "consultar_proveedores_producto":
      rendered = renderSuppliers(last.result.data);
      break;
    case "resumen_inventario":
      rendered = renderSummary(message, last.result.data);
      break;
  }
  return rendered ?? "La consulta se completó, pero no pude presentar el resultado de forma segura.";
}
