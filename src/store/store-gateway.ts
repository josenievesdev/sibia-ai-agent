export type ProductState = "activo" | "inactivo";
export type StockFilter = "con_stock" | "sin_stock" | "todos";
export type ProductSort =
  | "nombre_asc"
  | "precio_asc"
  | "precio_desc"
  | "stock_asc"
  | "stock_desc";

export interface ProductListItem {
  id: string;
  codigoReferencia: string | null;
  nombre: string;
  categoria: {
    id: string;
    nombre: string | null;
  };
  unidadMedida: string;
  precioVenta: number;
  stockRegistrado: number;
  stockMinimo: number;
  estado: ProductState;
  stockBajo: boolean;
}

/*
 * Único criterio de "stock bajo" de SIBIA, idéntico al de
 * public.vista_productos_stock_bajo y al conteo de resumen_inventario:
 * producto activo con stock registrado menor o igual a su stock
 * mínimo. Ninguna otra capa lo recalcula ni lo aproxima; el modelo solo
 * lee el campo stockBajo que sale de aquí.
 */
export const LOW_STOCK_CRITERION =
  "activo_y_stock_registrado_menor_o_igual_al_minimo" as const;

export function isLowStock(
  estado: ProductState,
  stockRegistrado: number,
  stockMinimo: number,
): boolean {
  return estado === "activo" && stockRegistrado <= stockMinimo;
}

export function countLowStock(products: readonly ProductListItem[]): number {
  return products.filter((product) => product.stockBajo).length;
}

/*
 * Texto comparable de un nombre o un código: sin acentos, en
 * minúsculas y con cualquier separador convertido en espacio.
 */
export function normalizeStoreText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export type ProductMatchQuality = "exacta" | "parcial";

export interface ProductSearchMatch extends ProductListItem {
  coincidencia: ProductMatchQuality;
}

/*
 * Distingue el producto que el usuario nombró de los productos que
 * solo contienen ese texto. La coincidencia es exacta cuando el
 * término buscado es el código completo, el nombre completo o una
 * secuencia completa de palabras del nombre; es parcial cuando solo
 * aparece dentro de una palabra más larga o llegó por parecido
 * tipográfico. "sal" es exacta en "Galletas Sal" y parcial en
 * "Salsa de tomate".
 */
export function classifyProductMatch(
  query: string,
  nombre: string,
  codigoReferencia: string | null,
): ProductMatchQuality {
  const normalizedQuery = normalizeStoreText(query);
  if (normalizedQuery === "") {
    return "parcial";
  }

  const normalizedCode = normalizeStoreText(codigoReferencia ?? "");
  const normalizedName = normalizeStoreText(nombre);
  if (normalizedCode === normalizedQuery || normalizedName === normalizedQuery) {
    return "exacta";
  }

  const queryWords = normalizedQuery.split(" ");
  const nameWords = normalizedName.split(" ");
  for (let start = 0; start + queryWords.length <= nameWords.length; start += 1) {
    if (queryWords.every((word, offset) => nameWords[start + offset] === word)) {
      return "exacta";
    }
  }
  return "parcial";
}

export interface ProductListQuery {
  categoriaId?: string;
  estado?: ProductState;
  existencia: StockFilter;
  orden: ProductSort;
  pagina: number;
  tamanoPagina: number;
}

export interface ProductPage {
  items: ProductListItem[];
  pagina: number;
  tamanoPagina: number;
  total: number;
  totalPaginas: number;
}

export interface ProductStock {
  id: string;
  codigoReferencia: string | null;
  nombre: string;
  unidadMedida: string;
  stockRegistrado: number;
  stockMinimo: number;
  estado: ProductState;
  stockBajo: boolean;
  cantidadVendibleConfirmada: false;
}

export interface ProductSupplier {
  id: string;
  nombre: string;
  nit: string | null;
  estado: string;
  codigoProveedor: string | null;
  precioCompraReferencia: number;
  esPrincipal: boolean;
}

export interface ProductSuppliers {
  producto: {
    id: string;
    codigoReferencia: string | null;
    nombre: string;
  };
  proveedores: ProductSupplier[];
}

export interface InventorySummary {
  totalProductos: number;
  productosActivos: number;
  productosSinStock: number;
  productosConStockBajo: number;
  criterioStockBajo: typeof LOW_STOCK_CRITERION;
}

export type StoreGatewayErrorCategory =
  | "authentication_failed"
  | "connection_error"
  | "permission_denied"
  | "query_error"
  | "schema_missing";

export class StoreGatewayError extends Error {
  readonly category: StoreGatewayErrorCategory;
  readonly code: string;

  constructor(
    category: StoreGatewayErrorCategory,
    code: string,
    message: string,
  ) {
    super(message);
    this.name = "StoreGatewayError";
    this.category = category;
    this.code = code;
  }
}

export interface StoreGateway {
  searchProducts(query: string, limit: number): Promise<ProductListItem[]>;
  listProducts(query: ProductListQuery): Promise<ProductPage>;
  getProductStock(productId: string): Promise<ProductStock | null>;
  getProductSuppliers(
    productId: string,
    limit: number,
  ): Promise<ProductSuppliers | null>;
  getInventorySummary(): Promise<InventorySummary>;
}
