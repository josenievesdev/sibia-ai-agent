import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";

import {
  StoreChatAgent,
  type ChatCompletionClient,
} from "../src/ai/sibia-agent.js";
import {
  inspectAssistantText,
  OllamaChatClient,
  OllamaChatError,
  type OllamaAssistantMessage,
  type OllamaChatMessage,
  type OllamaToolCall,
} from "../src/ai/ollama-client.js";
import {
  BACKEND_NOTICE_PREFIX,
  buildSibiaSystemPrompt,
  SIBIA_SYSTEM_PROMPT,
} from "../src/ai/system-prompt.js";
import {
  runInteractiveChat,
  welcomeBanner,
} from "../src/console/interactive-chat.js";
import {
  classifyProductMatch,
  countLowStock,
  isLowStock,
  LOW_STOCK_CRITERION,
  type InventorySummary,
  type ProductListItem,
  type ProductListQuery,
  type ProductPage,
  type ProductSearchMatch,
  type StoreGateway,
} from "../src/store/store-gateway.js";
import {
  STORE_READ_TOOL_DEFINITIONS,
  StoreReadToolCatalog,
  type StoreToolCallResult,
} from "../src/tools/store-read-tool-catalog.js";
import { StoreReadTools } from "../src/tools/store-read-tools.js";

const COCA_350 = "11111111-1111-4111-8111-111111111111";
const COCA_1500 = "22222222-2222-4222-8222-222222222222";

function product(id: string, nombre: string, stock: number) {
  return {
    id,
    nombre,
    codigoReferencia: `REF-${nombre.length}`,
    categoria: { id: "aaaaaaaa-1111-4111-8111-111111111111", nombre: "Bebidas" },
    unidadMedida: "unidad",
    precioVenta: 3_000,
    stockRegistrado: stock,
    stockMinimo: 5,
    estado: "activo",
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}): OllamaToolCall {
  return { type: "function", function: { name, arguments: args } };
}

function assistant(
  content: string,
  calls: readonly OllamaToolCall[] = [],
): OllamaAssistantMessage {
  const message: OllamaAssistantMessage = { role: "assistant", content };
  if (calls.length > 0) {
    message.tool_calls = [...calls];
  }
  return message;
}

/*
 * Modelo falso: prueba el ciclo, no sustituye la comprobación directa
 * contra ministral-3:8b. Un Error programado se lanza como fallo.
 */
class ScriptedModel implements ChatCompletionClient {
  readonly seen: OllamaChatMessage[][] = [];
  private index = 0;

  constructor(private readonly replies: readonly (OllamaAssistantMessage | Error)[]) {}

  async complete(
    messages: readonly OllamaChatMessage[],
  ): Promise<OllamaAssistantMessage> {
    this.seen.push(messages.map((message) => ({ ...message })));
    const reply = this.replies[this.index];
    this.index += 1;
    if (reply === undefined) {
      throw new Error("El modelo falso se quedó sin respuestas programadas.");
    }
    if (reply instanceof Error) {
      throw reply;
    }
    return reply;
  }

  get calls(): number {
    return this.index;
  }
}

class FailingModel implements ChatCompletionClient {
  constructor(private readonly error: Error) {}

  async complete(): Promise<OllamaAssistantMessage> {
    throw this.error;
  }
}

type ToolHandler = (args: unknown) => StoreToolCallResult;

class FakeCatalog {
  readonly definitions = STORE_READ_TOOL_DEFINITIONS;
  readonly executed: { name: string; arguments: unknown }[] = [];

  constructor(private readonly handlers: Record<string, ToolHandler>) {}

  async execute(name: string, args: unknown): Promise<StoreToolCallResult> {
    this.executed.push({ name, arguments: args });
    const handler = this.handlers[name];
    if (handler === undefined) {
      return {
        tool: name,
        status: "invalid_input",
        message: "La herramienta solicitada no está registrada en SIBIA.",
        data: null,
        meta: {},
        error: { code: "TOOL_NOT_REGISTERED" },
      };
    }
    return handler(args);
  }
}

function agentWith(
  replies: readonly (OllamaAssistantMessage | Error)[],
  handlers: Record<string, ToolHandler> = {},
): { agent: StoreChatAgent; model: ScriptedModel; catalog: FakeCatalog } {
  const model = new ScriptedModel(replies);
  const catalog = new FakeCatalog(handlers);
  const agent = new StoreChatAgent(
    model,
    catalog as unknown as StoreReadToolCatalog,
  );
  return { agent, model, catalog };
}

const ok = (tool: string, data: unknown): StoreToolCallResult => ({
  tool,
  status: "ok",
  message: "",
  data,
  meta: {},
  error: null,
});

const empty = (tool: string): StoreToolCallResult => ({
  tool,
  status: "empty",
  message: "Sin resultados.",
  data: null,
  meta: {},
  error: null,
});

const invalid = (tool: string, message: string): StoreToolCallResult => ({
  tool,
  status: "invalid_input",
  message,
  data: null,
  meta: {},
  error: { code: "INVALID_ARGUMENTS" },
});

/*
 * 49 productos con stock distinto: (índice * 7) % 50 no se repite.
 * Más stock: Producto 08 (49) y Producto 15 (48).
 * Menos stock: Producto 01 (0) y Producto 44 (1).
 */
const CATALOG: ProductListItem[] = Array.from({ length: 49 }, (_, index) => {
  const stock = (index * 7) % 50;
  return {
    id: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    codigoReferencia: `P-${index + 1}`,
    nombre: `Producto ${String(index + 1).padStart(2, "0")}`,
    categoria: { id: "c0000001-0000-4000-8000-000000000001", nombre: "General" },
    unidadMedida: "unidad",
    precioVenta: 1_000 + index,
    stockRegistrado: stock,
    stockMinimo: 5,
    estado: "activo",
    stockBajo: stock <= 5,
  };
});

/*
 * Gateway en memoria: sustituye a Supabase para probar el contrato de
 * la tool, no la consulta SQL.
 */
class MemoryGateway implements StoreGateway {
  readonly listQueries: ProductListQuery[] = [];

  async listProducts(query: ProductListQuery): Promise<ProductPage> {
    this.listQueries.push({ ...query });
    const sorted = [...CATALOG].sort((left, right) =>
      query.orden === "stock_desc"
        ? right.stockRegistrado - left.stockRegistrado
        : query.orden === "stock_asc"
          ? left.stockRegistrado - right.stockRegistrado
          : left.nombre.localeCompare(right.nombre),
    );
    const first = (query.pagina - 1) * query.tamanoPagina;
    return {
      items: sorted.slice(first, first + query.tamanoPagina),
      pagina: query.pagina,
      tamanoPagina: query.tamanoPagina,
      total: CATALOG.length,
      totalPaginas: Math.ceil(CATALOG.length / query.tamanoPagina),
    };
  }

  async searchProducts(): Promise<ProductListItem[]> {
    return [];
  }

  async getProductStock(): Promise<null> {
    return null;
  }

  async getProductSuppliers(): Promise<null> {
    return null;
  }

  async getInventorySummary(): Promise<InventorySummary> {
    throw new Error("No se usa en estas pruebas.");
  }
}

test("1. un mensaje social llega al modelo y su texto llega al usuario", async () => {
  const { agent, model, catalog } = agentWith([
    assistant("¡Hola! ¿En qué te ayudo con la tienda?"),
  ]);

  const turn = await agent.respond("Hola");

  assert.equal(turn.text, "¡Hola! ¿En qué te ayudo con la tienda?");
  assert.equal(turn.status, "ok");
  assert.equal(catalog.executed.length, 0);
  const sent = model.seen[0] ?? [];
  assert.equal(sent[0]?.role, "system");
  assert.equal(sent.at(-1)?.content, "Hola");
});

test("2. el modelo pide una tool, el backend la ejecuta y el resultado vuelve al modelo", async () => {
  const { agent, model, catalog } = agentWith(
    [
      assistant("", [toolCall("resumen_inventario")]),
      assistant("Ahora mismo hay 49 productos registrados, 47 de ellos activos."),
    ],
    {
      resumen_inventario: () =>
        ok("resumen_inventario", { totalProductos: 49, productosActivos: 47 }),
    },
  );

  const turn = await agent.respond("¿Cuántos productos tenemos?");

  assert.equal(catalog.executed[0]?.name, "resumen_inventario");
  const second = model.seen[1] ?? [];
  const toolMessage = second.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.equal(toolMessage?.tool_name, "resumen_inventario");
  assert.match(String(toolMessage?.content), /"totalProductos":49/u);
  assert.equal(second.at(-2)?.role, "assistant");
  assert.equal(second.at(-2)?.tool_calls?.length, 1);
  assert.equal(turn.status, "ok");
});

test("3. el texto final posterior a la tool es el del modelo, sin plantillas", async () => {
  const finalText =
    "Ahora mismo hay 49 productos registrados, 47 de ellos activos. ¿Miramos alguno en concreto?";
  const { agent } = agentWith(
    [assistant("", [toolCall("resumen_inventario")]), assistant(finalText)],
    {
      resumen_inventario: () =>
        ok("resumen_inventario", { totalProductos: 49, productosActivos: 47 }),
    },
  );

  const turn = await agent.respond("¿Cuántos productos tenemos?");

  assert.equal(turn.text, finalText);
});

test("4. con varias coincidencias el modelo recibe el resultado y pide aclaración", async () => {
  const clarification =
    "Encontré dos: la Coca Cola de 350 ml y la de 1.5 L. ¿Cuál te interesa?";
  const { agent, model } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "coca cola" })]),
      assistant(clarification),
    ],
    {
      buscar_productos: () =>
        ok("buscar_productos", [
          product(COCA_350, "Coca Cola 350 ml", 24),
          product(COCA_1500, "Coca Cola 1.5 L", 10),
        ]),
    },
  );

  const turn = await agent.respond("Quiero saber cuántas Coca Colas tenemos");

  assert.equal(turn.text, clarification);
  assert.equal(model.calls, 2);
  assert.equal(turn.state.candidates.length, 2);
  assert.equal(turn.state.selectedProduct, null);
});

test("5. un resultado vacío vuelve al modelo y lo explica el modelo", async () => {
  const explanation = "No encontré ningún producto con ese nombre en la tienda.";
  const { agent, model } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "quinoa" })]),
      assistant(explanation),
    ],
    { buscar_productos: () => empty("buscar_productos") },
  );

  const turn = await agent.respond("¿Tenemos quinoa?");

  assert.equal(turn.text, explanation);
  assert.equal(turn.status, "empty");
  assert.match(String((model.seen[1] ?? []).at(-1)?.content), /"status":"empty"/u);
});

test("6. unos argumentos inválidos vuelven al modelo como error estructurado", async () => {
  const { agent, model, catalog } = agentWith(
    [
      assistant("", [toolCall("listar_productos", { consulta: "coca cola" })]),
      assistant("", [toolCall("buscar_productos", { consulta: "coca cola" })]),
      assistant("Encontré la Coca Cola de 350 ml, con 24 unidades."),
    ],
    {
      listar_productos: () =>
        invalid("listar_productos", "Parámetros no permitidos: consulta."),
      buscar_productos: () =>
        ok("buscar_productos", [product(COCA_350, "Coca Cola 350 ml", 24)]),
    },
  );

  const turn = await agent.respond("Quiero saber cuántas Coca Colas tenemos");

  assert.match(
    String((model.seen[1] ?? []).at(-1)?.content),
    /"status":"invalid_input"/u,
  );
  assert.equal(catalog.executed.length, 2);
  assert.equal(turn.text, "Encontré la Coca Cola de 350 ml, con 24 unidades.");
});

test("7. dos rondas de tools encadenadas funcionan", async () => {
  const { agent, catalog } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "coca cola 350" })]),
      assistant("", [toolCall("consultar_stock", { productoId: COCA_350 })]),
      assistant("Quedan 24 unidades de Coca Cola 350 ml."),
    ],
    {
      buscar_productos: () =>
        ok("buscar_productos", [product(COCA_350, "Coca Cola 350 ml", 24)]),
      consultar_stock: () =>
        ok("consultar_stock", {
          id: COCA_350,
          nombre: "Coca Cola 350 ml",
          stockRegistrado: 24,
        }),
    },
  );

  const turn = await agent.respond("¿Cuánta Coca Cola 350 nos queda?");

  assert.deepEqual(
    catalog.executed.map((entry) => entry.name),
    ["buscar_productos", "consultar_stock"],
  );
  assert.equal(turn.text, "Quedan 24 unidades de Coca Cola 350 ml.");
  assert.equal(turn.toolResults.length, 2);
});

test("8. el límite de rondas corta un bucle de tools", async () => {
  const replies = Array.from({ length: 12 }, () =>
    assistant("", [toolCall("resumen_inventario")]),
  );
  const { agent, catalog } = agentWith(replies, {
    resumen_inventario: () => ok("resumen_inventario", { totalProductos: 49 }),
  });

  const turn = await agent.respond("¿Cuántos productos tenemos?");

  assert.equal(turn.status, "limit_reached");
  assert.ok(catalog.executed.length <= 10);
});

test("9. el historial conserva el mensaje del usuario y la respuesta final", async () => {
  const { agent, model } = agentWith(
    [
      assistant("", [toolCall("resumen_inventario")]),
      assistant("Tenemos 49 productos."),
      assistant("Claro, dime qué producto te interesa."),
    ],
    { resumen_inventario: () => ok("resumen_inventario", { totalProductos: 49 }) },
  );

  await agent.respond("¿Cuántos productos tenemos?");
  await agent.respond("Gracias");

  const third = model.seen[2] ?? [];
  const history = third.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  assert.deepEqual(
    history.map((message) => message.content),
    ["¿Cuántos productos tenemos?", "Tenemos 49 productos.", "Gracias"],
  );
  assert.equal(
    third.some((message) => message.role === "tool"),
    false,
  );
});

test("10. la memoria conserva candidatos y la selección del usuario", async () => {
  const { agent, catalog } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "coca cola" })]),
      assistant("Encontré dos. ¿Cuál te interesa?"),
      assistant("", [toolCall("consultar_stock", { productoId: COCA_1500 })]),
      assistant("De la Coca Cola de 1.5 L quedan 10 unidades."),
    ],
    {
      buscar_productos: () =>
        ok("buscar_productos", [
          product(COCA_350, "Coca Cola 350 ml", 24),
          product(COCA_1500, "Coca Cola 1.5 L", 10),
        ]),
      consultar_stock: () =>
        ok("consultar_stock", {
          id: COCA_1500,
          nombre: "Coca Cola 1.5 L",
          stockRegistrado: 10,
        }),
    },
  );

  await agent.respond("Quiero saber cuántas Coca Colas tenemos");
  const turn = await agent.respond("el segundo");

  assert.equal(turn.state.selectedProduct?.id, COCA_1500);
  assert.equal(catalog.executed[1]?.name, "consultar_stock");
  assert.equal(turn.text, "De la Coca Cola de 1.5 L quedan 10 unidades.");
});

test("11. un id de producto no confiable se rechaza y vuelve al modelo", async () => {
  const { agent, catalog, model } = agentWith(
    [
      assistant("", [
        toolCall("consultar_stock", {
          productoId: "99999999-9999-4999-8999-999999999999",
        }),
      ]),
      assistant("Necesito identificar antes el producto. ¿Cómo se llama?"),
    ],
    { consultar_stock: () => ok("consultar_stock", { id: "x" }) },
  );

  const turn = await agent.respond("¿Cuánto stock hay?");

  assert.equal(catalog.executed.length, 0);
  assert.match(
    String((model.seen[1] ?? []).at(-1)?.content),
    /UNTRUSTED_ENTITY_REFERENCE/u,
  );
  assert.equal(turn.text, "Necesito identificar antes el producto. ¿Cómo se llama?");
});

test("12. una respuesta truncada del cliente no se entrega como texto del modelo", async () => {
  const model = new FailingModel(
    new OllamaChatError(
      "truncated_response",
      "Ollama cortó la respuesta por límite de tokens; no se entregó ni se guardó.",
    ),
  );
  const agent = new StoreChatAgent(
    model,
    new FakeCatalog({}) as unknown as StoreReadToolCatalog,
  );

  const turn = await agent.respond("Muéstrame el catálogo completo");

  assert.equal(turn.status, "error");
  assert.match(turn.text, /límite de tokens/u);
});

test("no existe un clasificador de intención: la misma frase social puede terminar en tool", async () => {
  const { agent, catalog } = agentWith(
    [
      assistant("", [toolCall("resumen_inventario")]),
      assistant("Todo bien por aquí: hay 49 productos registrados."),
    ],
    { resumen_inventario: () => ok("resumen_inventario", { totalProductos: 49 }) },
  );

  const turn = await agent.respond("¿Qué tal va todo?");

  assert.equal(catalog.executed[0]?.name, "resumen_inventario");
  assert.equal(turn.text, "Todo bien por aquí: hay 49 productos registrados.");
});

test("el contexto de sesión solo se envía cuando existe", async () => {
  const { agent, model } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "coca cola" })]),
      assistant("Encontré la Coca Cola de 350 ml."),
      assistant("Sí, dime."),
    ],
    {
      buscar_productos: () =>
        ok("buscar_productos", [product(COCA_350, "Coca Cola 350 ml", 24)]),
    },
  );

  await agent.respond("Busca coca cola");
  await agent.respond("Otra cosa");

  const systemsFirstTurn = (model.seen[0] ?? []).filter(
    (message) => message.role === "system",
  );
  const systemsLastTurn = (model.seen[2] ?? []).filter(
    (message) => message.role === "system",
  );
  assert.equal(systemsFirstTurn.length, 1);
  assert.equal(systemsLastTurn.length, 2);
  assert.match(String(systemsLastTurn[1]?.content), /Contexto confiable de sesión/u);
});

test("la consola entrega al modelo todo mensaje distinto de /salir", async (t) => {
  t.mock.method(console, "log", () => undefined);
  const inputs = ["Hola", "zxcv qwer", "el segundo", "¿Cuántos productos hay?", "/salir", "no llega"];
  const { agent, model } = agentWith(
    inputs.slice(0, 4).map((_, index) => assistant(`Respuesta ${index + 1}`)),
  );

  await runInteractiveChat(agent, {
    ask: async () => inputs.shift() ?? "/salir",
  });

  assert.deepEqual(
    model.seen.map((messages) => messages.at(-1)?.content),
    ["Hola", "zxcv qwer", "el segundo", "¿Cuántos productos hay?"],
  );
});

test("un reintento de Ollama repite solo la petición fallida, no la tool ya ejecutada", async () => {
  const steps = [
    {
      status: 200,
      payload: {
        model: "ministral-3:8b",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "resumen_inventario", arguments: {} } }],
        },
        done: true,
        done_reason: "stop",
      },
    },
    { status: 500, payload: { error: "model runner has unexpectedly stopped" } },
    {
      status: 200,
      payload: {
        model: "ministral-3:8b",
        message: { role: "assistant", content: "Hay 49 productos registrados." },
        done: true,
        done_reason: "stop",
      },
    },
  ];
  let requests = 0;
  const fetchStub = (async () => {
    const step = steps[Math.min(requests, steps.length - 1)]!;
    requests += 1;
    return new Response(JSON.stringify(step.payload), {
      status: step.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new OllamaChatClient(
    {
      baseUrl: "http://127.0.0.1:11434",
      chatTimeoutMs: 5_000,
      debug: false,
      model: "ministral-3:8b",
      numCtx: 6_144,
    },
    fetchStub,
  );
  const catalog = new FakeCatalog({
    resumen_inventario: () => ok("resumen_inventario", { totalProductos: 49 }),
  });
  const agent = new StoreChatAgent(client, catalog as unknown as StoreReadToolCatalog);

  const turn = await agent.respond("¿Cuántos productos hay?");

  assert.equal(requests, 3);
  assert.equal(catalog.executed.length, 1);
  assert.equal(turn.status, "ok");
  assert.equal(turn.text, "Hay 49 productos registrados.");
});

test("un fallo técnico mostrado al usuario queda en el historial que ve el modelo", async () => {
  const { agent, model } = agentWith([
    new OllamaChatError("http_error", "Ollama respondió con HTTP 500."),
    assistant("El turno anterior falló porque Ollama respondió con un error 500."),
  ]);

  const failed = await agent.respond("Muéstrame el catálogo");
  const next = await agent.respond("¿Por qué falló?");

  assert.equal(failed.status, "error");
  assert.equal(failed.text, "Ollama respondió con HTTP 500.");
  const history = (model.seen[1] ?? []).filter((message) => message.role !== "system");
  assert.equal(history[0]?.content, "Muéstrame el catálogo");
  assert.equal(history[1]?.role, "assistant");
  assert.equal(history[1]?.content, `${BACKEND_NOTICE_PREFIX} Ollama respondió con HTTP 500.`);
  assert.equal(history[2]?.content, "¿Por qué falló?");
  assert.ok(SIBIA_SYSTEM_PROMPT.includes(BACKEND_NOTICE_PREFIX));
  assert.equal(next.text, "El turno anterior falló porque Ollama respondió con un error 500.");
});

test("el historial extenso se acota sin perder el estado de sesión", async () => {
  const longReply = "Detalle de inventario. ".repeat(80);
  const chatter = Array.from({ length: 20 }, (_, index) =>
    assistant(`${index + 1}. ${longReply}`),
  );
  const { agent, model } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "coca cola" })]),
      assistant("Encontré dos. ¿Cuál te interesa?"),
      ...chatter,
      assistant("Es la Coca Cola de 1.5 L."),
    ],
    {
      buscar_productos: () =>
        ok("buscar_productos", [
          product(COCA_350, "Coca Cola 350 ml", 24),
          product(COCA_1500, "Coca Cola 1.5 L", 10),
        ]),
    },
  );

  await agent.respond("Busca coca cola");
  for (let index = 0; index < chatter.length; index += 1) {
    await agent.respond(`Pregunta de seguimiento ${index + 1}`);
  }
  const last = await agent.respond("¿Cuál era la segunda opción?");

  const sent = model.seen.at(-1) ?? [];
  const history = sent.filter((message) => message.role !== "system").slice(0, -1);
  const context = sent.filter((message) => message.role === "system")[1];

  assert.ok(history.length <= 12);
  assert.ok(history.length >= 2);
  assert.equal(history.at(-2)?.content, "Pregunta de seguimiento 20");
  assert.equal(history.some((message) => message.content === "Busca coca cola"), false);
  assert.ok(history.every((message) => message.content.length <= 1_510));
  assert.match(String(context?.content), new RegExp(COCA_1500, "u"));
  assert.equal(last.state.candidates.length, 2);
  assert.equal(last.state.selectedProduct?.id, COCA_1500);
});

test("un resultado que no cabe en el contexto vuelve al modelo sin datos y el reintento indicado sí cabe", async () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    product(
      `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      `Producto con un nombre bastante largo ${index}`,
      index,
    ),
  );
  /*
   * Modelo que sigue la indicación del rechazo: vuelve a pedir la
   * cantidad de registros que el backend dice que cabe.
   */
  const seen: OllamaChatMessage[][] = [];
  const model: ChatCompletionClient = {
    async complete(messages) {
      seen.push([...messages]);
      const last = messages.at(-1);
      if (last?.role !== "tool") {
        return assistant("", [toolCall("buscar_productos", { consulta: "producto", limite: 60 })]);
      }
      const { result } = JSON.parse(last.content) as { result: StoreToolCallResult };
      if (result.error?.code === "RESULT_TOO_LARGE") {
        return assistant("", [
          toolCall("buscar_productos", {
            consulta: "producto",
            limite: result.meta.registrosQueCaben,
          }),
        ]);
      }
      return assistant(`Muestro ${(result.data as unknown[]).length} productos.`);
    },
  };
  const catalog = new FakeCatalog({
    buscar_productos: (args) =>
      ok("buscar_productos", many.slice(0, (args as { limite: number }).limite)),
  });
  const agent = new StoreChatAgent(model, catalog as unknown as StoreReadToolCatalog);

  const turn = await agent.respond("Busca producto");

  const rejection = (seen[1] ?? []).at(-1);
  assert.equal(rejection?.role, "tool");
  assert.match(String(rejection?.content), /RESULT_TOO_LARGE/u);
  assert.ok(String(rejection?.content).length < 1_000);
  const fitting = turn.toolResults[0]?.result.meta.registrosQueCaben;
  assert.ok(typeof fitting === "number" && fitting > 0);
  assert.equal(turn.toolResults[1]?.result.status, "ok");
  assert.equal(turn.state.candidates.length, fitting);
  assert.equal(turn.text, `Muestro ${fitting} productos.`);
});

test("listar_productos acepta orden por precio y lo entrega al gateway", async () => {
  const gateway = new MemoryGateway();
  const tools = new StoreReadTools(gateway);

  const result = await tools.listar_productos({ orden: "precio_asc", tamanoPagina: 1 });

  assert.equal(result.status, "ok");
  assert.equal(gateway.listQueries[0]?.orden, "precio_asc");
});

test("un listado paginado declara que es parcial y no la lista completa", async () => {
  const tools = new StoreReadTools(new MemoryGateway());

  const result = await tools.listar_productos({ tamanoPagina: 10 });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.meta, {
    total: 49,
    cantidadEntregada: 10,
    pagina: 1,
    tamanoPagina: 10,
    totalPaginas: 5,
    hayMasPaginas: true,
    siguientePagina: 2,
    primeraPosicion: 1,
    ultimaPosicion: 10,
    esListaCompleta: false,
    orden: "nombre_asc",
    productosConStockBajo: 1,
    criterioStockBajo: LOW_STOCK_CRITERION,
  });
  assert.match(result.message, /parcial.*10 de 49/u);
  assert.match(SIBIA_SYSTEM_PROMPT, /nunca lo presentes como el catálogo completo/u);
});

test("el ordenamiento permite obtener los dos productos con más y con menos stock", async () => {
  const gateway = new MemoryGateway();
  const catalog = new StoreReadToolCatalog(new StoreReadTools(gateway));
  const finalText =
    "Con más stock: Producto 08 y Producto 15. Con menos stock: Producto 01 y Producto 44.";
  const model = new ScriptedModel([
    assistant("", [
      toolCall("listar_productos", { orden: "stock_desc", tamanoPagina: 2 }),
      toolCall("listar_productos", { orden: "stock_asc", tamanoPagina: 2 }),
    ]),
    assistant(finalText),
  ]);
  const agent = new StoreChatAgent(model, catalog);

  const turn = await agent.respond("¿Cuáles son los dos con más stock y los dos con menos?");

  assert.deepEqual(
    gateway.listQueries.map((query) => [query.orden, query.tamanoPagina]),
    [
      ["stock_desc", 2],
      ["stock_asc", 2],
    ],
  );
  const names = turn.toolResults.map((execution) =>
    (execution.result.data as ProductPage).items.map((item) => item.nombre),
  );
  assert.deepEqual(names, [
    ["Producto 08", "Producto 15"],
    ["Producto 01", "Producto 44"],
  ]);
  const toolMessages = (model.seen[1] ?? []).filter((message) => message.role === "tool");
  assert.equal(toolMessages.length, 2);
  assert.equal(turn.text, finalText);
});

/*
 * Cliente real de Ollama sobre un fetch simulado que devuelve los
 * cuerpos indicados y guarda cada petición enviada.
 */
function ollamaReplying(steps: readonly Record<string, unknown>[]): {
  client: OllamaChatClient;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const fetchStub = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const payload = steps[Math.min(bodies.length - 1, steps.length - 1)];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const client = new OllamaChatClient(
    {
      baseUrl: "http://127.0.0.1:11434",
      chatTimeoutMs: 5_000,
      debug: false,
      model: "ministral-3:8b",
      numCtx: 6_144,
    },
    fetchStub,
  );
  return { client, bodies };
}

const sentMessages = (body: Record<string, unknown> | undefined): OllamaChatMessage[] =>
  (body?.messages ?? []) as OllamaChatMessage[];

function toolCallPayload(
  name: string,
  args: Record<string, unknown>,
  content = "",
): Record<string, unknown> {
  return {
    model: "ministral-3:8b",
    message: {
      role: "assistant",
      content,
      tool_calls: [{ function: { name, arguments: args } }],
    },
    done: true,
    done_reason: "stop",
  };
}

function textPayload(content: string, doneReason = "stop"): Record<string, unknown> {
  return {
    model: "ministral-3:8b",
    message: { role: "assistant", content },
    done: true,
    done_reason: doneReason,
  };
}

const DAMAGED_OUTPUT = `zq${"_7812".repeat(300)}`;
const LEAKED_TOOL_ERROR = '{"error":{"type":"invalid_input","message":"consulta vacía"}}';

test("una tool con argumentos inválidos no filtra su JSON al usuario y el modelo corrige", async () => {
  const { client, bodies } = ollamaReplying([
    toolCallPayload("buscar_productos", { consulta: "" }),
    toolCallPayload("resumen_inventario", {}),
    textPayload("Tenemos 49 productos registrados."),
  ]);
  const catalog = new FakeCatalog({
    buscar_productos: () => invalid("buscar_productos", "consulta debe ser un texto no vacío."),
    resumen_inventario: () => ok("resumen_inventario", { totalProductos: 49 }),
  });
  const agent = new StoreChatAgent(client, catalog as unknown as StoreReadToolCatalog);

  const turn = await agent.respond("¿Cuántos productos tenemos?");

  assert.equal(turn.text, "Tenemos 49 productos registrados.");
  assert.doesNotMatch(turn.text, /invalid_input|\{/u);
  const rejection = sentMessages(bodies[1]).at(-1);
  assert.equal(rejection?.role, "tool");
  assert.match(String(rejection?.content), /"status":"invalid_input"/u);
  assert.deepEqual(
    catalog.executed.map((execution) => execution.name),
    ["buscar_productos", "resumen_inventario"],
  );
});

test("el texto parcial que acompaña a una tool call no llega al usuario ni vuelve al modelo", async () => {
  const partial = 'Voy a revisar {"parcial": 6454_6543';
  const { client, bodies } = ollamaReplying([
    toolCallPayload("resumen_inventario", {}, partial),
    textPayload("Tenemos 49 productos registrados."),
  ]);
  const catalog = new FakeCatalog({
    resumen_inventario: () => ok("resumen_inventario", { totalProductos: 49 }),
  });
  const agent = new StoreChatAgent(client, catalog as unknown as StoreReadToolCatalog);

  const turn = await agent.respond("¿Cuántos productos tenemos?");

  assert.equal(turn.text, "Tenemos 49 productos registrados.");
  const echoedCall = sentMessages(bodies[1]).find((message) => message.tool_calls !== undefined);
  assert.equal(echoedCall?.content, "");
  assert.equal(JSON.stringify(bodies[1]).includes("6454_6543"), false);
});

test("dos respuestas dañadas seguidas producen un mensaje técnico limpio", async () => {
  const { client, bodies } = ollamaReplying([
    textPayload(DAMAGED_OUTPUT),
    textPayload(LEAKED_TOOL_ERROR),
    textPayload("El turno anterior falló porque el modelo generó una respuesta dañada."),
  ]);
  const agent = new StoreChatAgent(client, new FakeCatalog({}) as unknown as StoreReadToolCatalog);

  const failed = await agent.respond("¿Cuántos productos tenemos?");

  assert.equal(failed.status, "error");
  assert.equal(bodies.length, 2);
  assert.doesNotMatch(failed.text, /7812|invalid_input|\{/u);

  await agent.respond("¿Qué pasó?");
  const stored = sentMessages(bodies[2]).find((message) => message.role === "assistant");
  assert.ok(stored?.content.startsWith(BACKEND_NOTICE_PREFIX));
  assert.equal(JSON.stringify(bodies[2]).includes("7812"), false);
});

test("una respuesta cortada por done_reason length no llega al usuario", async () => {
  const { client, bodies } = ollamaReplying([
    textPayload("Aquí tienes los productos:\n1. Agua Cristal", "length"),
  ]);
  const agent = new StoreChatAgent(client, new FakeCatalog({}) as unknown as StoreReadToolCatalog);

  const turn = await agent.respond("Muéstrame los productos");

  assert.equal(turn.status, "error");
  assert.equal(bodies.length, 2);
  assert.equal(turn.text.includes("Aquí tienes"), false);
});

test("repetir una llamada ya rechazada corta el ciclo con un mensaje limpio", async () => {
  const { agent, catalog } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "" })]),
      assistant("", [toolCall("buscar_productos", { consulta: "" })]),
    ],
    {
      buscar_productos: () =>
        invalid("buscar_productos", "consulta debe ser un texto no vacío."),
    },
  );

  const turn = await agent.respond("¿Cuántos productos tenemos?");

  assert.equal(catalog.executed.length, 1);
  assert.equal(turn.status, "limit_reached");
  assert.doesNotMatch(turn.text, /buscar_productos|invalid_input|\{/u);
});

test("el agente no entrega una salida dañada aunque el cliente la deje pasar", async () => {
  const { agent } = agentWith([assistant(LEAKED_TOOL_ERROR)]);

  const turn = await agent.respond("¿Cuántos productos tenemos?");

  assert.equal(turn.status, "error");
  assert.doesNotMatch(turn.text, /invalid_input|\{/u);
});

test("la capa de IA no contiene clasificadores de intención ni renderizadores", async () => {
  const aiFiles = await readdir(new URL("../src/ai/", import.meta.url));
  assert.deepEqual([...aiFiles].sort(), [
    "ollama-client.ts",
    "session-state.ts",
    "sibia-agent.ts",
    "system-prompt.ts",
  ]);

  const sourceFiles = await readdir(new URL("../src/", import.meta.url), {
    recursive: true,
  });
  assert.equal(
    sourceFiles.some((file) =>
      /intent|presentation|grounded|render|classifier/iu.test(String(file)),
    ),
    false,
  );
});

/*
 * Pruebas de la pasada de corrección. Todos los productos son
 * sintéticos: ninguna regla del backend depende de un nombre concreto.
 */

const SYNTHETIC_IDS = Array.from(
  { length: 12 },
  (_, index) => `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

function syntheticProduct(
  index: number,
  overrides: Partial<ProductListItem> = {},
): ProductListItem {
  const stock = 10 + index;
  return {
    id: SYNTHETIC_IDS[index]!,
    codigoReferencia: `SX-${String(index + 1).padStart(2, "0")}`,
    nombre: `Artículo Sintético ${String(index + 1).padStart(2, "0")}`,
    categoria: { id: "c0000002-0000-4000-8000-000000000002", nombre: "Prueba" },
    unidadMedida: "unidad",
    precioVenta: 1_500 + index * 10,
    stockRegistrado: stock,
    stockMinimo: 2,
    estado: "activo",
    stockBajo: isLowStock("activo", stock, 2),
    ...overrides,
  };
}

/*
 * Gateway de doce productos con un orden total y estable: nombre y,
 * como desempate, id. Sirve para comprobar que tres páginas seguidas no
 * repiten ni se saltan elementos.
 */
class PaginatedGateway implements StoreGateway {
  readonly listQueries: ProductListQuery[] = [];
  readonly products: ProductListItem[];

  constructor(products: readonly ProductListItem[]) {
    this.products = [...products].sort((left, right) => {
      const byName = left.nombre.localeCompare(right.nombre, "es", {
        sensitivity: "base",
      });
      return byName !== 0 ? byName : left.id.localeCompare(right.id);
    });
  }

  async listProducts(query: ProductListQuery): Promise<ProductPage> {
    this.listQueries.push({ ...query });
    const first = (query.pagina - 1) * query.tamanoPagina;
    return {
      items: this.products.slice(first, first + query.tamanoPagina),
      pagina: query.pagina,
      tamanoPagina: query.tamanoPagina,
      total: this.products.length,
      totalPaginas: Math.ceil(this.products.length / query.tamanoPagina),
    };
  }

  async searchProducts(): Promise<ProductListItem[]> {
    return [];
  }

  async getProductStock(): Promise<null> {
    return null;
  }

  async getProductSuppliers(): Promise<null> {
    return null;
  }

  async getInventorySummary(): Promise<InventorySummary> {
    return {
      totalProductos: this.products.length,
      productosActivos: this.products.length,
      productosSinStock: 0,
      productosConStockBajo: countLowStock(this.products),
      criterioStockBajo: LOW_STOCK_CRITERION,
    };
  }
}

test("caso 1: «el segundo» señala la posición mostrada, no la que el modelo elija", async () => {
  const shown = [syntheticProduct(0), syntheticProduct(1), syntheticProduct(2)];
  const { agent, catalog } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "articulo" })]),
      assistant("1. Artículo Sintético 01\n2. Artículo Sintético 02\n3. Artículo Sintético 03"),
      /* El modelo pide el tercero cuando el usuario dijo "el segundo". */
      assistant("", [toolCall("consultar_stock", { productoId: shown[2]!.id })]),
      assistant("", [toolCall("consultar_stock", { productoId: shown[1]!.id })]),
      assistant("El segundo es Artículo Sintético 02 y tiene 11 unidades registradas."),
    ],
    {
      buscar_productos: () => ok("buscar_productos", shown),
      consultar_stock: (args) => {
        const id = (args as { productoId: string }).productoId;
        const found = shown.find((item) => item.id === id)!;
        return ok("consultar_stock", {
          id: found.id,
          codigoReferencia: found.codigoReferencia,
          nombre: found.nombre,
          unidadMedida: found.unidadMedida,
          stockRegistrado: found.stockRegistrado,
          stockMinimo: found.stockMinimo,
          estado: found.estado,
          stockBajo: found.stockBajo,
          cantidadVendibleConfirmada: false,
        });
      },
    },
  );

  await agent.respond("Muéstrame tres artículos");
  const turn = await agent.respond("¿Cuánto stock tiene el segundo?");

  /*
   * El modelo intentó dos productos; solo el de la posición 2 llegó a
   * ejecutarse contra el catálogo.
   */
  assert.deepEqual(
    turn.toolResults.map(
      (execution) => (execution.arguments as { productoId: string }).productoId,
    ),
    [shown[2]!.id, shown[1]!.id],
  );
  assert.deepEqual(
    catalog.executed
      .filter((execution) => execution.name === "consultar_stock")
      .map((execution) => (execution.arguments as { productoId: string }).productoId),
    [shown[1]!.id],
  );
  const rejection = turn.toolResults[0]?.result;
  assert.equal(rejection?.status, "invalid_input");
  assert.equal(rejection?.error?.code, "UNTRUSTED_ENTITY_REFERENCE");
  assert.match(String(rejection?.message), /posición 2/u);
  assert.match(String(rejection?.message), new RegExp(shown[1]!.nombre, "u"));
  assert.equal(turn.toolResults[1]?.result.status, "ok");
  assert.equal(turn.state.selectedProduct?.id, shown[1]!.id);
});

test("caso 1b: un reordenamiento del modelo dentro del turno no mueve la posición", async () => {
  const shown = Array.from({ length: 4 }, (_, index) => syntheticProduct(index));
  const reordered = [...shown].reverse();
  assert.notEqual(reordered[1]!.id, shown[1]!.id);
  const { agent } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "articulo" })]),
      assistant("1. Artículo Sintético 01\n2. Artículo Sintético 02\n3. Artículo Sintético 03\n4. Artículo Sintético 04"),
      assistant("", [toolCall("buscar_productos", { consulta: "articulo sintetico" })]),
      /* Segunda posición de la lista nueva, distinta de la mostrada. */
      assistant("", [toolCall("consultar_stock", { productoId: reordered[1]!.id })]),
      assistant("Me refiero a Artículo Sintético 02, el segundo que te mostré."),
    ],
    {
      buscar_productos: (args) =>
        ok(
          "buscar_productos",
          (args as { consulta: string }).consulta === "articulo" ? shown : reordered,
        ),
      consultar_stock: () => ok("consultar_stock", { id: reordered[1]!.id }),
    },
  );

  await agent.respond("Muéstrame cuatro artículos");
  const turn = await agent.respond("Dame el stock del segundo");

  const stockResult = turn.toolResults.find(
    (execution) => execution.name === "consultar_stock",
  )?.result;
  assert.equal(stockResult?.status, "invalid_input");
  assert.match(String(stockResult?.message), new RegExp(shown[1]!.nombre, "u"));
});

test("caso 1c: un número suelto de la consulta no selecciona una posición", async () => {
  const shown = Array.from({ length: 5 }, (_, index) => syntheticProduct(index));
  const { agent } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "articulo" })]),
      assistant("Te muestro cinco artículos."),
      assistant("", [toolCall("consultar_stock", { productoId: shown[3]!.id })]),
      assistant("Ese artículo tiene stock registrado."),
    ],
    {
      buscar_productos: () => ok("buscar_productos", shown),
      consultar_stock: () => ok("consultar_stock", { id: shown[3]!.id }),
    },
  );

  await agent.respond("Muéstrame 5 artículos");
  const turn = await agent.respond("Dame el stock del Artículo Sintético 04");

  assert.equal(turn.toolResults[0]?.result.status, "ok");
});

test("caso 2: stock 6 con mínimo 2 no es stock bajo en ninguna capa", async () => {
  const holgado = syntheticProduct(0, {
    stockRegistrado: 6,
    stockMinimo: 2,
    stockBajo: isLowStock("activo", 6, 2),
  });
  const escaso = syntheticProduct(1, {
    stockRegistrado: 2,
    stockMinimo: 2,
    stockBajo: isLowStock("activo", 2, 2),
  });

  assert.equal(isLowStock("activo", 6, 2), false);
  assert.equal(isLowStock("activo", 2, 2), true);
  assert.equal(holgado.stockBajo, false);

  const tools = new StoreReadTools(new PaginatedGateway([holgado, escaso]));

  const listed = await tools.listar_productos({ tamanoPagina: 5 });
  assert.equal(listed.meta.productosConStockBajo, 1);
  assert.equal(listed.meta.criterioStockBajo, LOW_STOCK_CRITERION);
  assert.deepEqual(
    (listed.data as ProductPage).items.map((item) => item.stockBajo),
    [false, true],
  );

  const summary = await tools.resumen_inventario();
  assert.equal((summary.data as InventorySummary).productosConStockBajo, 1);

  /* El modelo no puede reinterpretar la regla desde los dos números. */
  assert.match(
    SIBIA_SYSTEM_PROMPT,
    /Solo dices que un producto tiene stock bajo cuando su stockBajo es true/u,
  );
  assert.match(SIBIA_SYSTEM_PROMPT, /cerca del mínimo/u);
});

test("caso 3: tres páginas seguidas mantienen orden y tamaño y no repiten productos", async () => {
  const gateway = new PaginatedGateway(
    Array.from({ length: 12 }, (_, index) => syntheticProduct(index)),
  );
  const tools = new StoreReadTools(gateway);

  const pages = [];
  for (const pagina of [1, 2, 3]) {
    pages.push(await tools.listar_productos({ pagina, tamanoPagina: 5 }));
  }

  const items = pages.map((page) => (page.data as ProductPage).items);
  assert.deepEqual(
    items.map((page) => page.length),
    [5, 5, 2],
  );
  assert.deepEqual(
    pages.map((page) => page.meta.tamanoPagina),
    [5, 5, 5],
  );
  assert.deepEqual(
    pages.map((page) => page.meta.siguientePagina),
    [2, 3, null],
  );
  assert.deepEqual(
    pages.map((page) => [page.meta.primeraPosicion, page.meta.ultimaPosicion]),
    [
      [1, 5],
      [6, 10],
      [11, 12],
    ],
  );

  const seen = items.flat().map((item) => item.id);
  assert.equal(new Set(seen).size, 12);
  assert.deepEqual(
    seen,
    gateway.products.map((item) => item.id),
  );
  /* Todos los elementos de las tres páginas traen los mismos campos. */
  const shapes = new Set(
    items.flat().map((item) => Object.keys(item).sort().join(",")),
  );
  assert.equal(shapes.size, 1);
});

test("caso 3b: «muéstrame más» continúa la consulta anterior sin repetir productos", async () => {
  const gateway = new PaginatedGateway(
    Array.from({ length: 12 }, (_, index) => syntheticProduct(index)),
  );
  const catalog = new StoreReadToolCatalog(new StoreReadTools(gateway));
  const model = new ScriptedModel([
    assistant("", [toolCall("listar_productos", { tamanoPagina: 5, pagina: 1 })]),
    assistant("Estos son los primeros cinco de doce."),
    assistant("", [toolCall("listar_productos", { tamanoPagina: 5, pagina: 2 })]),
    assistant("Continúo con los cinco siguientes."),
  ]);
  const agent = new StoreChatAgent(model, catalog);

  const first = await agent.respond("Muéstrame 5 productos");
  const firstIds = first.state.candidates.map((candidate) => candidate.id);
  assert.equal(first.state.lastList?.siguientePagina, 2);
  assert.equal(first.state.lastList?.tamanoPagina, 5);

  const second = await agent.respond("Muéstrame más");
  const secondIds = second.state.candidates.map((candidate) => candidate.id);

  assert.deepEqual(
    gateway.listQueries.map((query) => [query.pagina, query.tamanoPagina, query.orden]),
    [
      [1, 5, "nombre_asc"],
      [2, 5, "nombre_asc"],
    ],
  );
  assert.equal(firstIds.length, 5);
  assert.equal(secondIds.length, 5);
  assert.equal(
    secondIds.some((id) => firstIds.includes(id)),
    false,
  );
  assert.equal(second.state.lastList?.siguientePagina, 3);
  /* El contexto del segundo turno llevaba la continuación del listado. */
  const context = (model.seen[2] ?? []).filter(
    (message) => message.role === "system",
  )[1];
  assert.match(String(context?.content), /"siguientePagina":2/u);
});

test("caso 4: una coincidencia dentro de una palabra más larga no es exacta", async () => {
  assert.equal(classifyProductMatch("vera", "Verapan Integral", "SX-90"), "parcial");
  assert.equal(classifyProductMatch("vera", "Vera Clásica 500 g", "SX-91"), "exacta");
  assert.equal(classifyProductMatch("vera clasica", "Vera Clásica 500 g", null), "exacta");
  assert.equal(classifyProductMatch("SX-91", "Vera Clásica 500 g", "SX-91"), "exacta");

  const parcial = syntheticProduct(0, { nombre: "Verapan Integral" });
  const exacta = syntheticProduct(1, { nombre: "Vera Clásica 500 g" });

  class SearchGateway extends PaginatedGateway {
    constructor(private readonly matches: readonly ProductListItem[]) {
      super([]);
    }

    override async searchProducts(): Promise<ProductListItem[]> {
      return [...this.matches];
    }
  }

  const soloParcial = await new StoreReadTools(
    new SearchGateway([parcial]),
  ).buscar_productos({ consulta: "vera" });
  assert.equal(soloParcial.status, "ok");
  assert.equal(soloParcial.meta.hayCoincidenciaExacta, false);
  assert.equal(soloParcial.meta.coincidenciasParciales, 1);
  assert.equal((soloParcial.data as ProductSearchMatch[])[0]?.coincidencia, "parcial");
  assert.match(soloParcial.message, /Ninguna coincidencia es exacta/u);

  const conExacta = await new StoreReadTools(
    new SearchGateway([exacta, parcial]),
  ).buscar_productos({ consulta: "vera" });
  assert.equal(conExacta.meta.hayCoincidenciaExacta, true);
  assert.deepEqual(
    (conExacta.data as ProductSearchMatch[]).map((match) => match.coincidencia),
    ["exacta", "parcial"],
  );
  assert.match(SIBIA_SYSTEM_PROMPT, /nunca afirmas que sí lo tenéis/u);
});

test("caso 5: una corrección del usuario llega al modelo y no dispara otra tool", async () => {
  const { agent, catalog, model } = agentWith(
    [
      assistant("", [toolCall("resumen_inventario", {})]),
      assistant("No tengo datos de ventas, así que no puedo decirte los más vendidos."),
      assistant(
        "Correcto, preguntaste por los productos más vendidos, no por los más baratos. Ahora mismo no tengo datos de ventas para responderlo.",
      ),
    ],
    { resumen_inventario: () => ok("resumen_inventario", { totalProductos: 12 }) },
  );

  await agent.respond("¿Cuáles son los productos más vendidos?");
  const turn = await agent.respond("No, yo no pregunté por el producto más barato");

  assert.equal(catalog.executed.length, 1);
  assert.equal(turn.toolResults.length, 0);
  assert.equal(
    (model.seen.at(-1) ?? []).at(-1)?.content,
    "No, yo no pregunté por el producto más barato",
  );
  assert.match(
    SIBIA_SYSTEM_PROMPT,
    /Si el usuario te corrige, empiezas reconociéndolo en una frase/u,
  );
});

test("caso 6: la bienvenida se adapta al negocio configurado y al valor neutro", () => {
  const configurada = welcomeBanner("Tienda La Esquina");
  assert.match(configurada, /^SIBIA\n/u);
  assert.match(configurada, /Asistente inteligente de inventario de Tienda La Esquina/u);
  assert.match(configurada, /Sesión segura iniciada\./u);
  assert.match(configurada, /\/salir/u);
  assert.doesNotMatch(configurada, /Sesión iniciada\. Escribe/u);

  const neutra = welcomeBanner();
  assert.match(neutra, /Asistente inteligente de inventario de esta tienda/u);
  assert.equal(welcomeBanner("   "), neutra);

  /* El mismo nombre identifica a SIBIA dentro del prompt del sistema. */
  assert.match(
    buildSibiaSystemPrompt("Tienda La Esquina"),
    /asistente de inventario de Tienda La Esquina/u,
  );
  assert.match(SIBIA_SYSTEM_PROMPT, /asistente de inventario de esta tienda/u);
});

test("caso 6b: la consola imprime la bienvenida una vez y no la pasa al modelo", async (t) => {
  const printed: string[] = [];
  t.mock.method(console, "log", (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  });
  const inputs = ["Hola", "/salir"];
  const { agent, model } = agentWith([assistant("¡Hola! ¿En qué te ayudo?")]);

  await runInteractiveChat(agent, {
    businessName: "Tienda La Esquina",
    ask: async () => inputs.shift() ?? "/salir",
  });

  assert.equal(printed[0], welcomeBanner("Tienda La Esquina"));
  assert.equal(
    printed.filter((line) => line.includes("Asistente inteligente")).length,
    1,
  );
  assert.deepEqual(
    model.seen.map((messages) => messages.at(-1)?.content),
    ["Hola"],
  );
});

test("caso 7: una tabla compacta de ranking llega al usuario tal como la escribió el modelo", async () => {
  const table = [
    "Ranking por stock registrado:",
    "",
    "| # | Producto | Stock | Mínimo | Precio |",
    "| --- | --- | --- | --- | --- |",
    "| 1 | Artículo Sintético 03 | 12 | 2 | 1.520 |",
    "| 2 | Artículo Sintético 02 | 11 | 2 | 1.510 |",
    "| 3 | Artículo Sintético 01 | 10 | 2 | 1.500 |",
  ].join("\n");
  const { agent } = agentWith(
    [
      assistant("", [toolCall("listar_productos", { orden: "stock_desc", tamanoPagina: 3 })]),
      assistant(table),
    ],
    {
      listar_productos: () =>
        ok("listar_productos", {
          items: [syntheticProduct(2), syntheticProduct(1), syntheticProduct(0)],
          pagina: 1,
          tamanoPagina: 3,
          total: 12,
          totalPaginas: 4,
        }),
    },
  );

  const turn = await agent.respond("Dame el ranking de los tres con más stock");

  assert.equal(turn.text, table);
  assert.equal(inspectAssistantText(turn.text), null);
  const columns = table
    .split("\n")
    .find((line) => line.startsWith("| #"))!
    .split("|")
    .filter((cell) => cell.trim() !== "").length;
  assert.ok(columns <= 5);
  assert.match(SIBIA_SYSTEM_PROMPT, /cinco columnas como máximo/u);
  assert.match(SIBIA_SYSTEM_PROMPT, /Para un solo producto usas una lista breve/u);
});

test("caso 8: una línea vacía vuelve a preguntar y no cierra el chat", async (t) => {
  const prompts: string[] = [];
  t.mock.method(console, "log", () => undefined);
  const inputs = ["", "   ", "Hola", "", "/salir", "no llega"];
  const { agent, model } = agentWith([assistant("¡Hola! ¿En qué te ayudo?")]);

  await runInteractiveChat(agent, {
    ask: async (prompt) => {
      prompts.push(prompt);
      return (inputs.shift() ?? "/salir").trim();
    },
  });

  /* Cinco entradas leídas: las vacías solo repitieron la pregunta. */
  assert.equal(prompts.length, 5);
  assert.deepEqual(new Set(prompts), new Set(["Tú: "]));
  assert.deepEqual(
    model.seen.map((messages) => messages.at(-1)?.content),
    ["Hola"],
  );
  assert.deepEqual(inputs, ["no llega"]);
});

test("caso 9: el contexto identifica el producto pero no lleva su stock ni su precio", async () => {
  const shown = [syntheticProduct(0), syntheticProduct(1)];
  const { agent, model } = agentWith(
    [
      assistant("", [toolCall("buscar_productos", { consulta: "articulo" })]),
      assistant("Encontré dos artículos."),
      assistant("", [toolCall("consultar_stock", { productoId: shown[1]!.id })]),
      assistant("El segundo tiene 11 unidades registradas."),
    ],
    {
      buscar_productos: () => ok("buscar_productos", shown),
      consultar_stock: () =>
        ok("consultar_stock", {
          id: shown[1]!.id,
          nombre: shown[1]!.nombre,
          stockRegistrado: shown[1]!.stockRegistrado,
          stockMinimo: shown[1]!.stockMinimo,
          estado: shown[1]!.estado,
          stockBajo: shown[1]!.stockBajo,
          cantidadVendibleConfirmada: false,
        }),
    },
  );

  await agent.respond("Busca artículos");
  const turn = await agent.respond("¿Cuánto stock tiene el segundo?");

  const context = String(
    (model.seen.at(-1) ?? []).filter((message) => message.role === "system")[1]
      ?.content,
  );
  /* Identifica: posición, id y nombre del producto seleccionado. */
  assert.match(context, /"selectedProduct"/u);
  assert.match(context, new RegExp(`"posicion":2,"id":"${shown[1]!.id}"`, "u"));
  assert.match(context, new RegExp(shown[1]!.nombre, "u"));
  /* No entrega datos mutables que evitarían volver a consultar. */
  assert.doesNotMatch(context, /stockRegistrado|stockMinimo|precioVenta|stockBajo/u);
  /* El estado interno sí los conserva para el backend. */
  assert.equal(turn.state.selectedProduct?.stockRegistrado, 11);
  assert.equal(
    turn.toolResults.filter((execution) => execution.name === "consultar_stock").length,
    1,
  );
});

test("caso 10: las reglas de herencia de argumentos y de tools sin datos están declaradas", () => {
  /* Una consulta nueva no arrastra el tamaño de la anterior. */
  assert.match(SIBIA_SYSTEM_PROMPT, /Una consulta nueva no hereda nada de la anterior/u);
  assert.match(SIBIA_SYSTEM_PROMPT, /omites tamanoPagina y dejas que la tool use su valor por defecto/u);
  assert.match(SIBIA_SYSTEM_PROMPT, /La única excepción es continuar un listado/u);

  const listar = STORE_READ_TOOL_DEFINITIONS.find(
    (definition) => definition.function.name === "listar_productos",
  );
  assert.match(listar!.function.description, /omite tamanoPagina cuando el usuario no indicó una cantidad/u);
  assert.equal(
    (listar!.function.parameters.properties as Record<string, { default?: number }>)
      .tamanoPagina?.default,
    10,
  );

  /* Una tool que no puede aportar datos no debe ejecutarse. */
  assert.match(SIBIA_SYSTEM_PROMPT, /Si el tema entero queda fuera de tus tools, como las ventas/u);
  const resumen = STORE_READ_TOOL_DEFINITIONS.find(
    (definition) => definition.function.name === "resumen_inventario",
  );
  assert.match(resumen!.function.description, /No contiene ventas, unidades vendidas, popularidad ni rotación/u);

  /* Una comparación de dos grupos va en una sola tabla. */
  assert.match(SIBIA_SYSTEM_PROMPT, /una sola tabla cuya primera columna "Grupo" dice a qué grupo pertenece cada fila/u);

  /* El dato mutable se vuelve a consultar aunque el producto ya se conozca. */
  assert.match(SIBIA_SYSTEM_PROMPT, /llamas otra vez a la tool aunque ya conozcas el producto/u);
});

/*
 * Invariante de paginación: una continuación conserva el tamaño, el
 * orden y los filtros del listado anterior, y dentro de un mismo turno
 * la misma página no puede volver a pedirse con otro tamaño.
 */
function paginationAgent(replies: readonly OllamaAssistantMessage[]): {
  agent: StoreChatAgent;
  gateway: PaginatedGateway;
} {
  const gateway = new PaginatedGateway(
    Array.from({ length: 12 }, (_, index) => syntheticProduct(index)),
  );
  const agent = new StoreChatAgent(
    new ScriptedModel(replies),
    new StoreReadToolCatalog(new StoreReadTools(gateway)),
  );
  return { agent, gateway };
}

const pageItems = (execution: { result: StoreToolCallResult } | undefined): string[] =>
  ((execution?.result.data as ProductPage | null)?.items ?? []).map((item) => item.id);

test("caso 11: una segunda llamada a la misma página con otro tamaño se rechaza", async () => {
  const { agent, gateway } = paginationAgent([
    assistant("", [toolCall("listar_productos", {})]),
    assistant("Estos son los primeros 10 de 12."),
    /* El fallo real: dos llamadas a la página 2 con tamaños distintos. */
    assistant("", [
      toolCall("listar_productos", { pagina: 2, tamanoPagina: 10 }),
      toolCall("listar_productos", { pagina: 2, tamanoPagina: 6 }),
    ]),
    assistant("Y estos son los 2 restantes."),
  ]);

  const first = await agent.respond("Muéstrame los productos");
  const second = await agent.respond("Muéstrame más");

  /* 1. La página 1 usó el tamaño predeterminado de la tool. */
  assert.equal(first.toolResults[0]?.result.status, "ok");
  assert.deepEqual(
    gateway.listQueries.map((query) => [query.pagina, query.tamanoPagina, query.orden]),
    [
      [1, 10, "nombre_asc"],
      [2, 10, "nombre_asc"],
    ],
  );

  /* 2 y 3. La página correcta se entregó; la incompatible se rechazó. */
  assert.equal(second.toolResults.length, 2);
  assert.equal(second.toolResults[0]?.result.status, "ok");
  assert.equal(second.toolResults[0]?.result.meta.tamanoPagina, 10);
  assert.equal(second.toolResults[1]?.result.status, "invalid_input");
  assert.equal(second.toolResults[1]?.result.error?.code, "INCONSISTENT_PAGE_SIZE");
  assert.equal(second.toolResults[1]?.result.data, null);
  /* El rechazo no sustituyó el resultado correcto ni tocó el gateway. */
  assert.equal(gateway.listQueries.length, 2);
  assert.equal(second.status, "ok");
  assert.equal(second.text, "Y estos son los 2 restantes.");

  /* 4. Ningún producto repetido entre las dos páginas. */
  const firstPage = pageItems(first.toolResults[0]);
  const secondPage = pageItems(second.toolResults[0]);
  assert.deepEqual([firstPage.length, secondPage.length], [10, 2]);
  assert.equal(new Set([...firstPage, ...secondPage]).size, 12);
});

test("caso 12: una continuación con otro tamaño se completa con los argumentos canónicos", async () => {
  const { agent, gateway } = paginationAgent([
    assistant("", [toolCall("listar_productos", {})]),
    assistant("Estos son los primeros 10 de 12."),
    /* Única llamada, con el tamaño equivocado y filtros incompletos. */
    assistant("", [toolCall("listar_productos", { pagina: 2, tamanoPagina: 6 })]),
    assistant("Y estos son los 2 restantes."),
  ]);

  const first = await agent.respond("Muéstrame los productos");
  const second = await agent.respond("Muéstrame más");

  assert.deepEqual(
    gateway.listQueries.map((query) => [query.pagina, query.tamanoPagina, query.orden]),
    [
      [1, 10, "nombre_asc"],
      [2, 10, "nombre_asc"],
    ],
  );
  assert.equal(second.toolResults[0]?.result.status, "ok");
  assert.equal(second.toolResults[0]?.result.meta.tamanoPagina, 10);
  assert.equal(second.toolResults[0]?.arguments &&
    (second.toolResults[0].arguments as { tamanoPagina: number }).tamanoPagina, 10);

  const firstPage = pageItems(first.toolResults[0]);
  const secondPage = pageItems(second.toolResults[0]);
  assert.equal(
    secondPage.some((id) => firstPage.includes(id)),
    false,
  );
  assert.equal(new Set([...firstPage, ...secondPage]).size, 12);
});

test("caso 13: el ranking con dos órdenes distintos sigue ejecutando ambas llamadas", async () => {
  const { agent, gateway } = paginationAgent([
    assistant("", [
      toolCall("listar_productos", { orden: "stock_desc", tamanoPagina: 2 }),
      toolCall("listar_productos", { orden: "stock_asc", tamanoPagina: 2 }),
    ]),
    assistant("Estos son los de mayor y menor stock."),
  ]);

  const turn = await agent.respond("Los 2 con más y los 2 con menos stock");

  assert.deepEqual(
    gateway.listQueries.map((query) => [query.orden, query.tamanoPagina, query.pagina]),
    [
      ["stock_desc", 2, 1],
      ["stock_asc", 2, 1],
    ],
  );
  assert.deepEqual(
    turn.toolResults.map((execution) => execution.result.status),
    ["ok", "ok"],
  );
});
