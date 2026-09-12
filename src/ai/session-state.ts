import {
  normalizeStoreText,
  type ProductListItem,
  type ProductPage,
  type ProductSort,
  type ProductState,
  type ProductStock,
  type ProductSuppliers,
  type StockFilter,
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
  stockBajo: boolean | null;
}

export interface ChatListState {
  source: "buscar_productos" | "listar_productos";
  consulta: string | null;
  categoriaId: string | null;
  estado: ProductState | "todos";
  existencia: StockFilter;
  orden: ProductSort | null;
  pagina: number | null;
  tamanoPagina: number;
  total: number | null;
  totalPaginas: number | null;
  siguientePagina: number | null;
}

export interface ChatSessionState {
  candidates: ChatProductReference[];
  selectedProduct: ChatProductReference | null;
  lastList: ChatListState | null;
}

/*
 * Como máximo veinte posiciones referenciables: es el mayor listado que
 * una tool puede entregar y lo que cabe en el contexto de sesión.
 */
const MAX_CANDIDATES = 20;

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

const LAST_POSITION = /(?:^|\b)(?:el|la)?\s*(?:ultimo|ultima)(?:\b|$)/u;

/*
 * Un número solo señala una posición cuando el usuario lo escribe como
 * posición: "el 2", "la opción 3". Un número suelto pertenece al
 * producto o a la cantidad pedida ("muéstrame 5 productos",
 * "Coca Cola 1.5L") y no selecciona nada.
 */
const POSITIONAL_NUMBER =
  /(?:^|\b)(?:el|la|opcion|numero|posicion|item)\s+([1-9][0-9]?)(?!\s*[0-9])(?:\b|$)/u;

/*
 * Resuelve una referencia posicional del usuario. No interpreta la
 * intención ni decide la respuesta: solo traduce "el segundo" o "el
 * último" a una posición de la lista que ya se mostró, para que el
 * backend pueda validar el producto que el modelo pide después.
 */
function positionFromMessage(message: string, shownCount: number): number | null {
  const value = normalize(message);
  if (value.includes("pagina")) {
    return null;
  }

  if (shownCount > 0 && LAST_POSITION.test(value)) {
    return shownCount;
  }

  const positional = value.match(POSITIONAL_NUMBER)?.[1];
  if (positional !== undefined) {
    return Number(positional);
  }

  for (const [word, ordinal] of Object.entries(ORDINALS)) {
    if (new RegExp(`(?:^|\\b)(?:el|la)?\\s*${word}(?:\\b|$)`, "u").test(value)) {
      return ordinal;
    }
  }
  return null;
}

function namesProduct(
  normalizedMessage: string,
  candidate: ChatProductReference,
): boolean {
  const name = normalizeStoreText(candidate.nombre);
  const code = normalizeStoreText(candidate.codigoReferencia ?? "");
  return (
    (name !== "" && normalizedMessage.includes(name)) ||
    (code !== "" && normalizedMessage.includes(code))
  );
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
    stockBajo: typeof product.stockBajo === "boolean" ? product.stockBajo : null,
  };
}

function valueAsInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

/*
 * Referencias válidas durante un turno. El marco posicional se fija al
 * empezar el turno con la lista que el usuario acaba de ver: si dentro
 * del mismo turno el modelo vuelve a consultar y recibe otro orden,
 * "el segundo" sigue señalando al segundo producto que se mostró.
 */
export class TurnReferences {
  private readonly deliveredProductIds = new Set<string>();
  private readonly deliveredCategoryIds = new Set<string>();
  /*
   * Páginas de listado ya entregadas en este turno, por firma de
   * filtros, orden y número de página, con el tamaño real con el que
   * se entregaron.
   */
  private readonly deliveredPages = new Map<string, number>();

  constructor(
    readonly position: number | null,
    readonly positionTarget: ChatProductReference | null,
    private readonly knownProductIds: ReadonlySet<string>,
    private readonly knownCategoryIds: ReadonlySet<string>,
    private readonly userIds: ReadonlySet<string>,
  ) {}

  allowsProduct(id: string): boolean {
    const value = id.toLowerCase();
    if (this.userIds.has(value)) {
      return true;
    }
    /*
     * Una posición resuelta es exclusiva: el usuario señaló un lugar
     * concreto de la lista mostrada y ningún otro producto responde a
     * esa referencia, aunque el modelo haya reordenado los resultados.
     */
    if (this.positionTarget !== null) {
      return this.positionTarget.id.toLowerCase() === value;
    }
    return (
      this.knownProductIds.has(value) || this.deliveredProductIds.has(value)
    );
  }

  allowsCategory(id: string): boolean {
    const value = id.toLowerCase();
    return (
      this.userIds.has(value) ||
      this.knownCategoryIds.has(value) ||
      this.deliveredCategoryIds.has(value)
    );
  }

  deliveredPageSize(signature: string): number | null {
    return this.deliveredPages.get(signature) ?? null;
  }

  recordListPage(signature: string, tamanoPagina: number): void {
    if (!this.deliveredPages.has(signature)) {
      this.deliveredPages.set(signature, tamanoPagina);
    }
  }

  recordDelivered(products: readonly ChatProductReference[]): void {
    for (const product of products) {
      this.deliveredProductIds.add(product.id.toLowerCase());
      if (product.categoriaId !== null) {
        this.deliveredCategoryIds.add(product.categoriaId.toLowerCase());
      }
    }
  }
}

export class ChatSessionMemory {
  private readonly state: ChatSessionState = {
    candidates: [],
    selectedProduct: null,
    lastList: null,
  };

  /*
   * Productos entregados por las tools del turno en curso, en el mismo
   * orden en que las tools los devolvieron. Al cerrar el turno pasan a
   * ser la lista referenciable, porque es la que el modelo presenta.
   */
  private delivered: ChatProductReference[] | null = null;

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

  /*
   * Abre el turno: fija el marco posicional sobre la lista mostrada y
   * devuelve las referencias con las que el backend validará los
   * argumentos de las tools de este turno.
   */
  beginTurn(message: string, userIds: ReadonlySet<string>): TurnReferences {
    this.delivered = null;

    const shown = this.state.candidates;
    const position = positionFromMessage(message, shown.length);
    const positionTarget =
      position === null ? null : (shown[position - 1] ?? null);

    if (positionTarget !== null) {
      this.state.selectedProduct = { ...positionTarget };
    } else {
      const normalizedMessage = normalizeStoreText(message);
      const named = shown.filter((candidate) =>
        namesProduct(normalizedMessage, candidate),
      );
      if (named.length === 1) {
        this.state.selectedProduct = { ...named[0]! };
      }
    }

    const knownProductIds = new Set<string>();
    if (this.state.selectedProduct !== null) {
      knownProductIds.add(this.state.selectedProduct.id.toLowerCase());
    }
    if (shown.length === 1) {
      knownProductIds.add(shown[0]!.id.toLowerCase());
    }

    const knownCategoryIds = new Set<string>();
    for (const candidate of shown) {
      if (candidate.categoriaId !== null) {
        knownCategoryIds.add(candidate.categoriaId.toLowerCase());
      }
    }
    const selectedCategoryId = this.state.selectedProduct?.categoriaId;
    if (selectedCategoryId !== undefined && selectedCategoryId !== null) {
      knownCategoryIds.add(selectedCategoryId.toLowerCase());
    }
    const listCategoryId = this.state.lastList?.categoriaId;
    if (listCategoryId !== undefined && listCategoryId !== null) {
      knownCategoryIds.add(listCategoryId.toLowerCase());
    }

    return new TurnReferences(
      position,
      positionTarget,
      knownProductIds,
      knownCategoryIds,
      userIds,
    );
  }

  /*
   * Cierra el turno. La lista referenciable pasa a ser exactamente lo
   * que las tools entregaron, en su orden de entrega; si el turno no
   * entregó ninguna lista, se conserva la anterior.
   */
  endTurn(): void {
    const delivered = this.delivered;
    this.delivered = null;
    if (delivered === null) {
      return;
    }

    this.state.candidates = delivered.slice(0, MAX_CANDIDATES);
    const selectedId = this.state.selectedProduct?.id ?? null;
    const single =
      this.state.candidates.length === 1 ? this.state.candidates[0]! : null;

    if (single !== null) {
      if (selectedId !== single.id) {
        this.state.selectedProduct = { ...single };
      }
      return;
    }
    /*
     * Una selección solo sobrevive a una lista nueva si ese producto
     * sigue estando en ella; en otro caso el usuario ya no tiene
     * delante aquello a lo que se refería.
     */
    if (
      selectedId !== null &&
      !this.state.candidates.some((candidate) => candidate.id === selectedId)
    ) {
      this.state.selectedProduct = null;
    }
  }

  /*
   * Argumentos canónicos del último listado paginado. Una continuación
   * los repite tal cual y solo cambia la página, de modo que el
   * tamaño, el orden y los filtros no puedan variar entre páginas de
   * un mismo listado. Devuelve null si el último listado no vino de
   * listar_productos y por tanto no hay nada que continuar.
   */
  continuationArguments(): Record<string, unknown> | null {
    const list = this.state.lastList;
    if (list === null || list.source !== "listar_productos" || list.orden === null) {
      return null;
    }

    const args: Record<string, unknown> = {
      estado: list.estado,
      existencia: list.existencia,
      orden: list.orden,
      tamanoPagina: list.tamanoPagina,
    };
    if (list.categoriaId !== null) {
      args.categoriaId = list.categoriaId;
    }
    return args;
  }

  update(
    name: string,
    argumentsValue: unknown,
    result: StoreToolCallResult,
    references: TurnReferences | null = null,
  ): void {
    if (result.status !== "ok" && result.status !== "empty") {
      return;
    }

    const args = isRecord(argumentsValue) ? argumentsValue : {};

    if (name === "buscar_productos") {
      const products = Array.isArray(result.data)
        ? (result.data as ProductListItem[])
        : [];
      this.addDelivered(products, references);
      this.state.lastList = {
        source: "buscar_productos",
        consulta: typeof args.consulta === "string" ? args.consulta : null,
        categoriaId: null,
        estado: "todos",
        existencia: "todos",
        orden: null,
        pagina: null,
        tamanoPagina: valueAsInteger(args.limite, 10),
        total: null,
        totalPaginas: null,
        siguientePagina: null,
      };
      return;
    }

    if (name === "listar_productos") {
      const page = result.data as ProductPage | null;
      if (page === null || !Array.isArray(page.items)) {
        return;
      }
      this.addDelivered(page.items, references);
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
          orden === "stock_asc" ||
          orden === "stock_desc" ||
          orden === "precio_asc" ||
          orden === "precio_desc"
            ? orden
            : "nombre_asc",
        pagina: page.pagina,
        tamanoPagina: page.tamanoPagina,
        total: page.total,
        totalPaginas: page.totalPaginas,
        siguientePagina:
          page.pagina < page.totalPaginas ? page.pagina + 1 : null,
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
        stockBajo: typeof stock.stockBajo === "boolean" ? stock.stockBajo : null,
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

  /*
   * JSON compacto y sin valores nulos: este contexto acompaña a cada
   * petición al modelo. Solo identifica: posición, id, nombre, código y
   * categoría. El stock, el precio y el estado quedan fuera a propósito,
   * porque cambian y el modelo debe volver a consultarlos con la tool
   * en lugar de leerlos aquí. El estado completo sigue disponible para
   * el backend en snapshot().
   */
  trustedContext(): string {
    const selected = this.state.selectedProduct;
    const selectedPosition = this.state.candidates.findIndex(
      (candidate) => candidate.id === selected?.id,
    );

    return JSON.stringify(
      {
        selectedProduct:
          selected === null
            ? null
            : {
                posicion: selectedPosition === -1 ? null : selectedPosition + 1,
                id: selected.id,
                nombre: selected.nombre,
                codigoReferencia: selected.codigoReferencia,
                categoriaId: selected.categoriaId,
                categoriaNombre: selected.categoriaNombre,
              },
        candidates: this.state.candidates.map((candidate, index) => ({
          posicion: index + 1,
          id: candidate.id,
          nombre: candidate.nombre,
        })),
        lastList: this.state.lastList,
      },
      (_key, value: unknown) => (value === null ? undefined : value),
    );
  }

  private addDelivered(
    products: readonly ProductListItem[],
    references: TurnReferences | null,
  ): void {
    const delivered = this.delivered ?? [];
    const known = new Set(delivered.map((product) => product.id));
    for (const product of products) {
      if (!known.has(product.id)) {
        known.add(product.id);
        delivered.push(productReference(product));
      }
    }
    this.delivered = delivered;
    references?.recordDelivered(delivered);
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
      stockBajo: values.stockBajo ?? known?.stockBajo ?? null,
    };
  }
}
