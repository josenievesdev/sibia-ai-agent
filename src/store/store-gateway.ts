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
 * Mismo criterio que public.vista_productos_stock_bajo y que el conteo
 * de resumen_inventario: producto activo con stock registrado menor o
 * igual a su stock mínimo.
 */
export function isLowStock(
  estado: ProductState,
  stockRegistrado: number,
  stockMinimo: number,
): boolean {
  return estado === "activo" && stockRegistrado <= stockMinimo;
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
  criterioStockBajo: "activo_y_stock_registrado_menor_o_igual_al_minimo";
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
