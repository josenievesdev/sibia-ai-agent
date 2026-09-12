import type { SupabaseClient } from "@supabase/supabase-js";

import { classifySupabaseQueryError } from "../integrations/supabase/check.js";
import {
  isLowStock,
  LOW_STOCK_CRITERION,
  normalizeStoreText,
  StoreGatewayError,
  type InventorySummary,
  type ProductListItem,
  type ProductListQuery,
  type ProductPage,
  type ProductState,
  type ProductStock,
  type ProductSupplier,
  type ProductSuppliers,
  type StoreGateway,
} from "./store-gateway.js";

const PRODUCT_COLUMNS = [
  "id_producto",
  "codigo_referencia",
  "nombre_producto",
  "id_categoria",
  "unidad_medida",
  "precio_venta",
  "stock_actual",
  "stock_minimo",
  "estado",
  "categoria:categorias!fk_productos_categoria(id_categoria,nombre)",
].join(",");

interface DatabaseCategory {
  id_categoria: string;
  nombre: string;
}

interface DatabaseProduct {
  id_producto: string;
  codigo_referencia: string | null;
  nombre_producto: string;
  id_categoria: string;
  unidad_medida: string;
  precio_venta: number | string;
  stock_actual: number | string;
  stock_minimo: number | string;
  estado: ProductState;
  categoria: DatabaseCategory | DatabaseCategory[] | null;
}

interface DatabaseStock {
  id_producto: string;
  codigo_referencia: string | null;
  nombre_producto: string;
  unidad_medida: string;
  stock_actual: number | string;
  stock_minimo: number | string;
  estado: ProductState;
}

interface DatabaseSupplier {
  id_proveedor: string;
  nombre: string;
  nit: string | null;
  estado: string;
}

interface DatabaseProductSupplier {
  id_proveedor: string;
  codigo_proveedor: string | null;
  precio_compra_referencia: number | string;
  es_principal: boolean;
  proveedor: DatabaseSupplier | DatabaseSupplier[] | null;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

const FUZZY_SEARCH_FALLBACK_LIMIT = 500;
const SEARCH_STOP_WORDS = new Set([
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
  "producto",
  "productos",
  "de",
  "del",
]);

function searchTokens(value: string): string[] {
  return normalizeStoreText(value)
    .split(" ")
    .filter((token) => token !== "" && !SEARCH_STOP_WORDS.has(token));
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left === "") {
    return right.length;
  }
  if (right === "") {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + substitutionCost,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function fuzzyProductScore(
  product: ProductListItem,
  rawQuery: string,
): number | null {
  const queryTokens = searchTokens(rawQuery);
  const nameTokens = searchTokens(product.nombre);
  if (queryTokens.length === 0 || nameTokens.length === 0) {
    return null;
  }

  let matched = 0;
  let distanceTotal = 0;
  const availableNameTokenIndexes = new Set(
    nameTokens.map((_, index) => index),
  );

  for (const queryToken of queryTokens) {
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestIndex: number | null = null;

    for (const index of availableNameTokenIndexes) {
      const nameToken = nameTokens[index];
      if (nameToken === undefined) {
        continue;
      }

      const directDistance = levenshteinDistance(queryToken, nameToken);
      const prefixDistance =
        nameToken.startsWith(queryToken) || queryToken.startsWith(nameToken)
          ? 1
          : directDistance;
      const candidateDistance = Math.min(directDistance, prefixDistance);

      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        bestIndex = index;
      }
    }

    const allowedDistance =
      queryToken.length <= 4
        ? 1
        : Math.max(1, Math.floor(queryToken.length * 0.3));
    if (bestIndex !== null && bestDistance <= allowedDistance) {
      matched += 1;
      distanceTotal += bestDistance;
      availableNameTokenIndexes.delete(bestIndex);
    }
  }

  const coverage = matched / queryTokens.length;
  if (coverage < 0.6) {
    return null;
  }

  return (queryTokens.length - matched) * 100 + distanceTotal * 10 + Math.abs(nameTokens.length - queryTokens.length);
}

function firstRelation<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value;
}

function numericValue(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new StoreGatewayError(
      "query_error",
      "INVALID_NUMERIC_VALUE",
      "Supabase devolvió un valor numérico inválido.",
    );
  }
  return parsed;
}

function mapProduct(row: DatabaseProduct): ProductListItem {
  const category = firstRelation(row.categoria);
  const stockRegistrado = numericValue(row.stock_actual);
  const stockMinimo = numericValue(row.stock_minimo);

  return {
    id: row.id_producto,
    codigoReferencia: row.codigo_referencia,
    nombre: row.nombre_producto,
    categoria: {
      id: row.id_categoria,
      nombre: category?.nombre ?? null,
    },
    unidadMedida: row.unidad_medida,
    precioVenta: numericValue(row.precio_venta),
    stockRegistrado,
    stockMinimo,
    estado: row.estado,
    stockBajo: isLowStock(row.estado, stockRegistrado, stockMinimo),
  };
}

function mapQueryError(
  resource: string,
  error: { code: string; message: string },
): StoreGatewayError {
  const classification = classifySupabaseQueryError(error);

  switch (classification.status) {
    case "authentication_failed":
      return new StoreGatewayError(
        "authentication_failed",
        "STORE_AUTHENTICATION_FAILED",
        "La sesión de Supabase no es válida.",
      );
    case "permission_denied":
      return new StoreGatewayError(
        "permission_denied",
        "STORE_PERMISSION_DENIED",
        `La sesión no tiene permiso para consultar ${resource}.`,
      );
    case "schema_missing":
      return new StoreGatewayError(
        "schema_missing",
        "STORE_SCHEMA_MISSING",
        `El recurso ${resource} no existe en el esquema disponible.`,
      );
    default:
      return new StoreGatewayError(
        "query_error",
        "STORE_QUERY_FAILED",
        `Falló la consulta de ${resource}.`,
      );
  }
}

function productRank(product: ProductListItem, normalizedQuery: string): number {
  const code = product.codigoReferencia?.toLocaleLowerCase("es") ?? "";
  const name = product.nombre.toLocaleLowerCase("es");

  if (code === normalizedQuery) {
    return 0;
  }
  if (code.startsWith(normalizedQuery)) {
    return 1;
  }
  if (name.startsWith(normalizedQuery)) {
    return 2;
  }
  return 3;
}

export class SupabaseStoreGateway implements StoreGateway {
  constructor(private readonly client: SupabaseClient) {}

  async searchProducts(
    query: string,
    limit: number,
  ): Promise<ProductListItem[]> {
    const pattern = `%${escapeLikePattern(query)}%`;
    const [codeResponse, nameResponse] = await Promise.all([
      this.client
        .from("productos")
        .select(PRODUCT_COLUMNS)
        .ilike("codigo_referencia", pattern)
        .order("nombre_producto", { ascending: true })
        .order("id_producto", { ascending: true })
        .limit(limit),
      this.client
        .from("productos")
        .select(PRODUCT_COLUMNS)
        .ilike("nombre_producto", pattern)
        .order("nombre_producto", { ascending: true })
        .order("id_producto", { ascending: true })
        .limit(limit),
    ]);

    if (codeResponse.error !== null) {
      throw mapQueryError("public.productos", codeResponse.error);
    }
    if (nameResponse.error !== null) {
      throw mapQueryError("public.productos", nameResponse.error);
    }

    const productsById = new Map<string, ProductListItem>();
    for (const row of [
      ...(codeResponse.data as unknown as DatabaseProduct[]),
      ...(nameResponse.data as unknown as DatabaseProduct[]),
    ]) {
      const product = mapProduct(row);
      productsById.set(product.id, product);
    }

    const normalizedQuery = query.toLocaleLowerCase("es");
    const exactMatches = [...productsById.values()]
      .sort((left, right) => {
        const rankDifference =
          productRank(left, normalizedQuery) -
          productRank(right, normalizedQuery);
        if (rankDifference !== 0) {
          return rankDifference;
        }

        const nameDifference = left.nombre.localeCompare(right.nombre, "es", {
          sensitivity: "base",
        });
        return nameDifference !== 0
          ? nameDifference
          : left.id.localeCompare(right.id);
      })
      .slice(0, limit);

    if (exactMatches.length > 0) {
      return exactMatches;
    }

    const fallbackResponse = await this.client
      .from("productos")
      .select(PRODUCT_COLUMNS)
      .order("nombre_producto", { ascending: true })
      .order("id_producto", { ascending: true })
      .limit(FUZZY_SEARCH_FALLBACK_LIMIT);

    if (fallbackResponse.error !== null) {
      throw mapQueryError("public.productos", fallbackResponse.error);
    }

    return (fallbackResponse.data as unknown as DatabaseProduct[])
      .map(mapProduct)
      .map((product) => ({
        product,
        score: fuzzyProductScore(product, query),
      }))
      .filter(
        (entry): entry is { product: ProductListItem; score: number } =>
          entry.score !== null,
      )
      .sort((left, right) => {
        const scoreDifference = left.score - right.score;
        if (scoreDifference !== 0) {
          return scoreDifference;
        }
        return left.product.nombre.localeCompare(right.product.nombre, "es", {
          sensitivity: "base",
        });
      })
      .slice(0, limit)
      .map((entry) => entry.product);
  }

  async listProducts(query: ProductListQuery): Promise<ProductPage> {
    let request = this.client
      .from("productos")
      .select(PRODUCT_COLUMNS, { count: "exact" });

    if (query.categoriaId !== undefined) {
      request = request.eq("id_categoria", query.categoriaId);
    }
    if (query.estado !== undefined) {
      request = request.eq("estado", query.estado);
    }
    if (query.existencia === "con_stock") {
      request = request.gt("stock_actual", 0);
    } else if (query.existencia === "sin_stock") {
      request = request.eq("stock_actual", 0);
    }

    const firstRow = (query.pagina - 1) * query.tamanoPagina;
    if (query.orden === "stock_asc") {
      request = request.order("stock_actual", { ascending: true });
    } else if (query.orden === "stock_desc") {
      request = request.order("stock_actual", { ascending: false });
    } else if (query.orden === "precio_asc") {
      request = request.order("precio_venta", { ascending: true });
    } else if (query.orden === "precio_desc") {
      request = request.order("precio_venta", { ascending: false });
    }

    const { data, error, count } = await request
      .order("nombre_producto", { ascending: true })
      .order("id_producto", { ascending: true })
      .range(firstRow, firstRow + query.tamanoPagina - 1);

    if (error !== null) {
      throw mapQueryError("public.productos", error);
    }

    const total = count ?? 0;
    return {
      items: (data as unknown as DatabaseProduct[]).map(mapProduct),
      pagina: query.pagina,
      tamanoPagina: query.tamanoPagina,
      total,
      totalPaginas: total === 0 ? 0 : Math.ceil(total / query.tamanoPagina),
    };
  }

  async getProductStock(productId: string): Promise<ProductStock | null> {
    const { data, error } = await this.client
      .from("productos")
      .select(
        "id_producto,codigo_referencia,nombre_producto,unidad_medida,stock_actual,stock_minimo,estado",
      )
      .eq("id_producto", productId)
      .maybeSingle();

    if (error !== null) {
      throw mapQueryError("public.productos", error);
    }
    if (data === null) {
      return null;
    }

    const row = data as unknown as DatabaseStock;
    const stockRegistrado = numericValue(row.stock_actual);
    const stockMinimo = numericValue(row.stock_minimo);
    return {
      id: row.id_producto,
      codigoReferencia: row.codigo_referencia,
      nombre: row.nombre_producto,
      unidadMedida: row.unidad_medida,
      stockRegistrado,
      stockMinimo,
      estado: row.estado,
      stockBajo: isLowStock(row.estado, stockRegistrado, stockMinimo),
      cantidadVendibleConfirmada: false,
    };
  }

  async getProductSuppliers(
    productId: string,
    limit: number,
  ): Promise<ProductSuppliers | null> {
    const { data: product, error: productError } = await this.client
      .from("productos")
      .select("id_producto,codigo_referencia,nombre_producto")
      .eq("id_producto", productId)
      .maybeSingle();

    if (productError !== null) {
      throw mapQueryError("public.productos", productError);
    }
    if (product === null) {
      return null;
    }

    const { data, error } = await this.client
      .from("productos_proveedores")
      .select(
        "id_proveedor,codigo_proveedor,precio_compra_referencia,es_principal,proveedor:proveedores!fk_pp_proveedor(id_proveedor,nombre,nit,estado)",
      )
      .eq("id_producto", productId)
      .order("es_principal", { ascending: false })
      .order("id_proveedor", { ascending: true })
      .limit(limit);

    if (error !== null) {
      throw mapQueryError("public.productos_proveedores", error);
    }

    const suppliers: ProductSupplier[] = (
      data as unknown as DatabaseProductSupplier[]
    ).map((row) => {
      const supplier = firstRelation(row.proveedor);
      if (supplier === null) {
        throw new StoreGatewayError(
          "permission_denied",
          "RELATED_SUPPLIER_NOT_VISIBLE",
          "La asociación existe, pero el proveedor no es visible para la sesión.",
        );
      }

      return {
        id: supplier.id_proveedor,
        nombre: supplier.nombre,
        nit: supplier.nit,
        estado: supplier.estado,
        codigoProveedor: row.codigo_proveedor,
        precioCompraReferencia: numericValue(
          row.precio_compra_referencia,
        ),
        esPrincipal: row.es_principal,
      };
    });

    suppliers.sort((left, right) => {
      if (left.esPrincipal !== right.esPrincipal) {
        return left.esPrincipal ? -1 : 1;
      }
      const nameDifference = left.nombre.localeCompare(right.nombre, "es", {
        sensitivity: "base",
      });
      return nameDifference !== 0
        ? nameDifference
        : left.id.localeCompare(right.id);
    });

    return {
      producto: {
        id: product.id_producto as string,
        codigoReferencia: product.codigo_referencia as string | null,
        nombre: product.nombre_producto as string,
      },
      proveedores: suppliers,
    };
  }

  async getInventorySummary(): Promise<InventorySummary> {
    const [total, active, withoutStock, lowStock] = await Promise.all([
      this.client
        .from("productos")
        .select("id_producto", { count: "exact", head: true }),
      this.client
        .from("productos")
        .select("id_producto", { count: "exact", head: true })
        .eq("estado", "activo"),
      this.client
        .from("productos")
        .select("id_producto", { count: "exact", head: true })
        .eq("stock_actual", 0),
      this.client
        .from("vista_productos_stock_bajo")
        .select("id_producto", { count: "exact", head: true }),
    ]);

    for (const [resource, response] of [
      ["public.productos", total],
      ["public.productos", active],
      ["public.productos", withoutStock],
      ["public.vista_productos_stock_bajo", lowStock],
    ] as const) {
      if (response.error !== null) {
        throw mapQueryError(resource, response.error);
      }
    }

    return {
      totalProductos: total.count ?? 0,
      productosActivos: active.count ?? 0,
      productosSinStock: withoutStock.count ?? 0,
      productosConStockBajo: lowStock.count ?? 0,
      criterioStockBajo: LOW_STOCK_CRITERION,
    };
  }
}
