import assert from "node:assert/strict";
import test from "node:test";

import {
  StoreChatAgent,
  type ChatCompletionClient,
} from "../src/agent/store-chat-agent.js";
import {
  OllamaChatError,
  type OllamaAssistantMessage,
  type OllamaChatMessage,
  type OllamaToolCall,
} from "../src/integrations/ollama/chat-client.js";
import {
  STORE_READ_TOOL_DEFINITIONS,
  type StoreReadToolCatalog,
  type StoreToolCallResult,
} from "../src/tools/store-read-tool-catalog.js";

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
 * contra ministral-3:8b.
 */
class ScriptedModel implements ChatCompletionClient {
  readonly seen: OllamaChatMessage[][] = [];
  private index = 0;

  constructor(private readonly replies: readonly OllamaAssistantMessage[]) {}

  async complete(
    messages: readonly OllamaChatMessage[],
  ): Promise<OllamaAssistantMessage> {
    this.seen.push(messages.map((message) => ({ ...message })));
    const reply = this.replies[this.index];
    this.index += 1;
    if (reply === undefined) {
      throw new Error("El modelo falso se quedó sin respuestas programadas.");
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
  replies: readonly OllamaAssistantMessage[],
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
