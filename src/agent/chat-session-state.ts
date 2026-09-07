import type {
  ProductListItem,
  ProductPage,
  ProductSort,
  ProductState,
  ProductStock,
  ProductSuppliers,
  StockFilter,
} from "../store/store-gateway.js";
import type { StoreToolCallResult } from "../tools/store-read-tool-catalog.js";

export interface ChatProductReference {
  id: string;
  nombre: string;
  codigoReferencia: string | null;
  categoriaId: string | null;
  categoriaNombre: string | null;
  unidadMedida: string | null;
  precioVenta: number | null;
  stockRegistrado: number | null;
  stockMinimo: number | null;
  estado: ProductState | null;
}

export interface ChatListState {
  source: "buscar_productos" | "listar_productos";
  consulta: string | null;
  categoriaId: string | null;
  estado: ProductState | "todos";
  existencia: StockFilter;
  orden: ProductSort;
  pagina: number | null;
  tamanoPagina: number;
  totalPaginas: number | null;
}

export interface ChatSessionState {
  candidates: ChatProductReference[];
  selectedProduct: ChatProductReference | null;
  lastList: ChatListState | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("es")
    .replace(/[¿?¡!.,;:()\[\]{}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const ORDINALS: Readonly<Record<string, number>> = {
  primer: 1,
  primero: 1,
  primera: 1,
  segundo: 2,
  segunda: 2,
  tercero: 3,
  tercera: 3,
  cuarto: 4,
  cuarta: 4,
  quinto: 5,
  quinta: 5,
  sexto: 6,
  sexta: 6,
  septimo: 7,
  septima: 7,
  octavo: 8,
  octava: 8,
  noveno: 9,
  novena: 9,
  decimo: 10,
  decima: 10,
};

function ordinalFromMessage(message: string): number | null {
  const value = normalize(message);
  if (value.includes("pagina")) {
    return null;
  }

  const numeric = value.match(/(?:^|\b)(?:el|la|opcion|producto)?\s*([1-9][0-9]?)(?:\b|$)/u)?.[1];
  if (numeric !== undefined) {
    return Number(numeric);
  }

  for (const [word, ordinal] of Object.entries(ORDINALS)) {
    if (new RegExp(`(?:^|\\b)(?:el|la)?\\s*${word}(?:\\b|$)`, "u").test(value)) {
      return ordinal;
    }
  }
  return null;
}

function productReference(product: ProductListItem): ChatProductReference {
  return {
    id: product.id,
    nombre: product.nombre,
    codigoReferencia: product.codigoReferencia,
    categoriaId: product.categoria.id,
    categoriaNombre: product.categoria.nombre,
    unidadMedida: product.unidadMedida,
    precioVenta: product.precioVenta,
    stockRegistrado: product.stockRegistrado,
    stockMinimo: product.stockMinimo,
    estado: product.estado,
  };
}

function valueAsInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

export class ChatSessionMemory {
  private readonly state: ChatSessionState = {
    candidates: [],
    selectedProduct: null,
    lastList: null,
  };

  snapshot(): ChatSessionState {
    return {
      candidates: this.state.candidates.map((candidate) => ({ ...candidate })),
      selectedProduct:
        this.state.selectedProduct === null
          ? null
          : { ...this.state.selectedProduct },
      lastList:
        this.state.lastList === null ? null : { ...this.state.lastList },
    };
  }

  applyExplicitSelection(message: string): void {
    if (this.state.candidates.length === 0) {
      return;
    }

    const ordinal = ordinalFromMessage(message);
    if (ordinal !== null) {
      const candidate = this.state.candidates[ordinal - 1];
      if (candidate !== undefined) {
        this.state.selectedProduct = { ...candidate };
        return;
      }
    }

    const normalizedMessage = normalize(message);
    const exactMatches = this.state.candidates.filter((candidate) => {
      const normalizedName = normalize(candidate.nombre);
      const normalizedCode = normalize(candidate.codigoReferencia ?? "");
      return (
        (normalizedName !== "" && normalizedMessage.includes(normalizedName)) ||
        (normalizedCode !== "" && normalizedMessage.includes(normalizedCode))
      );
    });

    if (exactMatches.length === 1) {
      this.state.selectedProduct = { ...exactMatches[0]! };
    }
  }

  allowedProductIds(message: string): ReadonlySet<string> {
    const ids = new Set<string>();
    if (this.state.selectedProduct !== null) {
      ids.add(this.state.selectedProduct.id.toLowerCase());
    }
    if (this.state.candidates.length === 1) {
      ids.add(this.state.candidates[0]!.id.toLowerCase());
    }

    const ordinal = ordinalFromMessage(message);
    if (ordinal !== null) {
      const candidate = this.state.candidates[ordinal - 1];
      if (candidate !== undefined) {
        ids.add(candidate.id.toLowerCase());
      }
    }

    const normalizedMessage = normalize(message);
    for (const candidate of this.state.candidates) {
      const name = normalize(candidate.nombre);
      const code = normalize(candidate.codigoReferencia ?? "");
      if (
        (name !== "" && normalizedMessage.includes(name)) ||
        (code !== "" && normalizedMessage.includes(code))
      ) {
        ids.add(candidate.id.toLowerCase());
      }
    }
    return ids;
  }

  allowedCategoryIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const candidate of this.state.candidates) {
      if (candidate.categoriaId !== null) {
        ids.add(candidate.categoriaId.toLowerCase());
      }
    }
    if (this.state.selectedProduct?.categoriaId !== null && this.state.selectedProduct?.categoriaId !== undefined) {
      ids.add(this.state.selectedProduct.categoriaId.toLowerCase());
    }
    if (this.state.lastList?.categoriaId !== null && this.state.lastList?.categoriaId !== undefined) {
      ids.add(this.state.lastList.categoriaId.toLowerCase());
    }
    return ids;
  }

  update(name: string, argumentsValue: unknown, result: StoreToolCallResult): void {
    if (result.status !== "ok" && result.status !== "empty") {
      return;
    }

    const args = isRecord(argumentsValue) ? argumentsValue : {};

    if (name === "buscar_productos") {
      const products = Array.isArray(result.data)
        ? (result.data as ProductListItem[])
        : [];
      this.replaceCandidates(products);
      this.state.lastList = {
        source: "buscar_productos",
        consulta: typeof args.consulta === "string" ? args.consulta : null,
        categoriaId: null,
        estado: "todos",
        existencia: "todos",
        orden: "nombre_asc",
        pagina: null,
        tamanoPagina: valueAsInteger(args.limite, 10),
        totalPaginas: null,
      };
      return;
    }

    if (name === "listar_productos") {
      const page = result.data as ProductPage | null;
      if (page === null || !Array.isArray(page.items)) {
        return;
      }
      this.replaceCandidates(page.items);
      const estado = args.estado;
      const existencia = args.existencia;
      const orden = args.orden;
      this.state.lastList = {
        source: "listar_productos",
        consulta: null,
        categoriaId: typeof args.categoriaId === "string" ? args.categoriaId : null,
        estado:
          estado === "activo" || estado === "inactivo" ? estado : "todos",
        existencia:
          existencia === "con_stock" || existencia === "sin_stock"
            ? existencia
            : "todos",
        orden:
          orden === "stock_asc" || orden === "stock_desc"
            ? orden
            : "nombre_asc",
        pagina: page.pagina,
        tamanoPagina: page.tamanoPagina,
        totalPaginas: page.totalPaginas,
      };
      return;
    }

    if (name === "consultar_stock" && isRecord(result.data)) {
      const stock = result.data as unknown as ProductStock;
      this.selectKnownProduct(stock.id, {
        nombre: stock.nombre,
        codigoReferencia: stock.codigoReferencia,
        unidadMedida: stock.unidadMedida,
        stockRegistrado: stock.stockRegistrado,
        stockMinimo: stock.stockMinimo,
        estado: stock.estado,
      });
      return;
    }

    if (name === "consultar_proveedores_producto" && isRecord(result.data)) {
      const suppliers = result.data as unknown as ProductSuppliers;
      this.selectKnownProduct(suppliers.producto.id, {
        nombre: suppliers.producto.nombre,
        codigoReferencia: suppliers.producto.codigoReferencia,
      });
    }
  }

  trustedContext(): string {
    return JSON.stringify(
      {
        selectedProduct: this.state.selectedProduct,
        candidates: this.state.candidates.slice(0, 20).map((candidate, index) => ({
          ordinal: index + 1,
          ...candidate,
        })),
        lastList: this.state.lastList,
      },
      null,
      2,
    );
  }

  private replaceCandidates(products: readonly ProductListItem[]): void {
    this.state.candidates = products.map(productReference);
    this.state.selectedProduct =
      this.state.candidates.length === 1
        ? { ...this.state.candidates[0]! }
        : null;
  }

  private selectKnownProduct(
    id: string,
    values: Partial<Omit<ChatProductReference, "id">>,
  ): void {
    const known = this.state.candidates.find((candidate) => candidate.id === id);
    this.state.selectedProduct = {
      id,
      nombre: values.nombre ?? known?.nombre ?? "Producto seleccionado",
      codigoReferencia:
        values.codigoReferencia ?? known?.codigoReferencia ?? null,
      categoriaId: known?.categoriaId ?? null,
      categoriaNombre: known?.categoriaNombre ?? null,
      unidadMedida: values.unidadMedida ?? known?.unidadMedida ?? null,
      precioVenta: known?.precioVenta ?? null,
      stockRegistrado:
        values.stockRegistrado ?? known?.stockRegistrado ?? null,
      stockMinimo: values.stockMinimo ?? known?.stockMinimo ?? null,
      estado: values.estado ?? known?.estado ?? null,
    };
  }
}
