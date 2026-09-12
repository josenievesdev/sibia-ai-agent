import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectAssistantText,
  OllamaChatClient,
  OllamaChatError,
  parseChatPayload,
  parseToolCalls,
} from "../src/ai/ollama-client.js";

const CONFIG = {
  baseUrl: "http://127.0.0.1:11434",
  chatTimeoutMs: 5_000,
  debug: false,
  model: "ministral-3:8b" as const,
  numCtx: 6_144,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(payloads: readonly unknown[]): {
  fetch: typeof fetch;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  let call = 0;
  const implementation = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const payload = payloads[Math.min(call, payloads.length - 1)];
    call += 1;
    return jsonResponse(payload);
  }) as unknown as typeof fetch;
  return { fetch: implementation, bodies };
}

/*
 * Copia saneada de una respuesta real de ministral-3:8b: sin `type` en
 * la tool call, con `index` dentro de `function` y `arguments` como
 * objeto.
 */
const REAL_TOOL_CALL_PAYLOAD = {
  model: "ministral-3:8b",
  created_at: "2026-09-09T01:30:48.026134Z",
  message: {
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: "call_lycsdspm",
        function: { index: 0, name: "resumen_inventario", arguments: {} },
      },
    ],
  },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 1649,
  eval_count: 9,
};

const REAL_TEXT_PAYLOAD = {
  model: "ministral-3:8b",
  message: {
    role: "assistant",
    content:
      "Tenemos **49 productos** en total en el inventario. ¿Necesitas algún detalle adicional?",
  },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 1672,
  eval_count: 40,
};

test("acepta una copia saneada del JSON real de ministral con tool call", () => {
  const parsed = parseChatPayload(REAL_TOOL_CALL_PAYLOAD);

  assert.equal(parsed.kind, "message");
  assert.ok(parsed.kind === "message");
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.message.content, "");
  assert.deepEqual(parsed.message.tool_calls, [
    {
      id: "call_lycsdspm",
      type: "function",
      function: { name: "resumen_inventario", arguments: {}, index: 0 },
    },
  ]);
});

test("acepta una copia saneada del JSON real con respuesta de texto", () => {
  const parsed = parseChatPayload(REAL_TEXT_PAYLOAD);

  assert.equal(parsed.kind, "message");
  assert.ok(parsed.kind === "message");
  assert.equal(parsed.message.tool_calls, undefined);
  assert.match(parsed.message.content, /49 productos/u);
});

test("acepta arguments como objeto y como JSON serializado", () => {
  const asObject = parseToolCalls([
    { function: { name: "buscar_productos", arguments: { consulta: "cola" } } },
  ]);
  const asString = parseToolCalls([
    { function: { name: "buscar_productos", arguments: '{"consulta":"cola"}' } },
  ]);

  assert.deepEqual(asObject?.calls[0]?.function.arguments, { consulta: "cola" });
  assert.deepEqual(asString?.calls[0]?.function.arguments, { consulta: "cola" });
});

test("no exige campos opcionales que Ollama no siempre entrega", () => {
  const withoutContent = parseChatPayload({
    message: {
      role: "assistant",
      tool_calls: [{ function: { name: "resumen_inventario" } }],
    },
    done: true,
  });

  assert.equal(withoutContent.kind, "message");
  assert.ok(withoutContent.kind === "message");
  assert.equal(withoutContent.message.content, "");
  assert.equal(withoutContent.message.tool_calls?.[0]?.function.name, "resumen_inventario");
});

test("deduplica llamadas repetidas a la misma tool con los mismos argumentos", () => {
  const parsed = parseToolCalls([
    { function: { name: "resumen_inventario", arguments: {} } },
    { function: { name: "resumen_inventario", arguments: {} } },
    { function: { name: "buscar_productos", arguments: { consulta: "cola" } } },
  ]);

  assert.equal(parsed?.calls.length, 2);
});

test("descarta una entrada malformada sin invalidar el resto de la respuesta", () => {
  const parsed = parseToolCalls([
    { function: { name: "", arguments: {} } },
    { function: { name: "resumen_inventario", arguments: {} } },
  ]);

  assert.equal(parsed?.malformed, 1);
  assert.equal(parsed?.calls.length, 1);
});

test("marca como truncada la respuesta cortada por límite de tokens", () => {
  const parsed = parseChatPayload({
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "length",
  });

  assert.equal(parsed.kind, "empty");
  assert.ok(parsed.kind === "empty");
  assert.equal(parsed.truncated, true);
});

test("declara num_ctx, temperatura única y un num_predict acotado", async () => {
  const { fetch: implementation, bodies } = stubFetch([REAL_TEXT_PAYLOAD]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await client.complete([{ role: "user", content: "Hola" }], []);

  const options = bodies[0]?.options as Record<string, unknown>;
  assert.equal(options.num_ctx, CONFIG.numCtx);
  assert.equal(options.temperature, 0.2);
  assert.equal(options.num_predict, 1_024);
  assert.equal(bodies[0]?.stream, false);
});

test("reintenta una sola vez y no entrega una respuesta truncada", async () => {
  const truncated = {
    message: { role: "assistant", content: "" },
    done: true,
    done_reason: "length",
  };
  const { fetch: implementation, bodies } = stubFetch([truncated, truncated]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await assert.rejects(
    () => client.complete([{ role: "user", content: "Hola" }], []),
    (error: unknown) =>
      error instanceof OllamaChatError && error.code === "truncated_response",
  );
  assert.equal(bodies.length, 2);
});

test("un turno vacío se reintenta y luego se reporta como invalid_response", async () => {
  const empty = { message: { role: "assistant", content: "" }, done: true };
  const { fetch: implementation, bodies } = stubFetch([empty, empty]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await assert.rejects(
    () => client.complete([{ role: "user", content: "Hola" }], []),
    (error: unknown) =>
      error instanceof OllamaChatError && error.code === "invalid_response",
  );
  assert.equal(bodies.length, 2);
});

test("el reintento recupera un turno vacío puntual", async () => {
  const { fetch: implementation } = stubFetch([
    { message: { role: "assistant", content: "" }, done: true },
    REAL_TEXT_PAYLOAD,
  ]);
  const client = new OllamaChatClient(CONFIG, implementation);

  const message = await client.complete([{ role: "user", content: "Hola" }], []);

  assert.match(message.content, /49 productos/u);
});

/*
 * Cuerpo real observado mientras Ollama recarga el runner del modelo.
 */
const RELOADING_PAYLOAD = {
  model: "",
  created_at: "0001-01-01T00:00:00Z",
  message: { role: "", content: "" },
  done: false,
};

test("reconoce el turno incompleto de Ollama mientras carga el modelo", () => {
  assert.equal(parseChatPayload(RELOADING_PAYLOAD).kind, "unavailable");
});

test("reintenta el turno incompleto y lo reporta como unavailable", async () => {
  const { fetch: implementation, bodies } = stubFetch([
    RELOADING_PAYLOAD,
    RELOADING_PAYLOAD,
  ]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await assert.rejects(
    () => client.complete([{ role: "user", content: "Hola" }], []),
    (error: unknown) =>
      error instanceof OllamaChatError && error.code === "unavailable",
  );
  assert.equal(bodies.length, 2);
});

test("propaga un error del modelo devuelto con HTTP 200", async () => {
  const { fetch: implementation } = stubFetch([{ error: "model not found" }]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await assert.rejects(
    () => client.complete([{ role: "user", content: "Hola" }], []),
    (error: unknown) =>
      error instanceof OllamaChatError && error.code === "model_error",
  );
});

/*
 * Cada paso es una respuesta HTTP o un fallo de red lanzado por fetch.
 */
function sequenceFetch(steps: readonly (Error | { status: number; payload: unknown })[]): {
  fetch: typeof fetch;
  requests: () => number;
} {
  let call = 0;
  const implementation = (async () => {
    const step = steps[Math.min(call, steps.length - 1)];
    call += 1;
    if (step instanceof Error) {
      throw step;
    }
    return jsonResponse(step?.payload, step?.status);
  }) as unknown as typeof fetch;
  return { fetch: implementation, requests: () => call };
}

test("un HTTP 500 transitorio se reintenta una sola vez y recupera el turno", async () => {
  const { fetch: implementation, requests } = sequenceFetch([
    { status: 500, payload: { error: "model runner has unexpectedly stopped" } },
    { status: 200, payload: REAL_TEXT_PAYLOAD },
  ]);
  const client = new OllamaChatClient(CONFIG, implementation);

  const message = await client.complete([{ role: "user", content: "Hola" }], []);

  assert.match(message.content, /49 productos/u);
  assert.equal(requests(), 2);
});

test("un HTTP 503 persistente falla tras un único reintento", async () => {
  const { fetch: implementation, requests } = sequenceFetch([
    { status: 503, payload: {} },
  ]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await assert.rejects(
    () => client.complete([{ role: "user", content: "Hola" }], []),
    (error: unknown) =>
      error instanceof OllamaChatError &&
      error.code === "http_error" &&
      /HTTP 503/u.test(error.message),
  );
  assert.equal(requests(), 2);
});

test("un HTTP 4xx no se reintenta", async () => {
  const { fetch: implementation, requests } = sequenceFetch([
    { status: 400, payload: { error: "invalid message format" } },
    { status: 200, payload: REAL_TEXT_PAYLOAD },
  ]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await assert.rejects(
    () => client.complete([{ role: "user", content: "Hola" }], []),
    (error: unknown) =>
      error instanceof OllamaChatError && error.code === "http_error",
  );
  assert.equal(requests(), 1);
});

const textPayload = (content: string, doneReason = "stop") => ({
  model: "ministral-3:8b",
  message: { role: "assistant", content },
  done: true,
  done_reason: doneReason,
});

const DAMAGED_OUTPUT = `zq${"_7812".repeat(300)}`;
const LEAKED_TOOL_ERROR = '{"error":{"type":"invalid_input","message":"consulta vacía"}}';

test("una salida con repetición extrema se rechaza", () => {
  assert.notEqual(inspectAssistantText(DAMAGED_OUTPUT), null);
  assert.notEqual(inspectAssistantText(`Tenemos ${"precio stock ".repeat(60)}`), null);
  assert.notEqual(inspectAssistantText("x".repeat(9_000)), null);
});

test("una salida con formato de protocolo interno se rechaza", () => {
  for (const sample of [
    '[TOOL_CALLS]buscar_productos[ARGS]{"consulta":""}',
    LEAKED_TOOL_ERROR,
    'Listo, aquí va: "tool_calls": []',
    "[INST]hola[/INST]",
    'resumen_inventario{"alcance":"todos"}',
  ]) {
    assert.notEqual(inspectAssistantText(sample), null, sample);
  }
});

test("las respuestas normales no se rechazan", () => {
  for (const sample of [
    "¡Hola! ¿En qué puedo ayudarte hoy con la tienda? 😊",
    "En la tienda tenemos **49 productos en total**, de los cuales **48 están activos** y **1 no tiene stock registrado**.\n\nDe los activos, **9 tienen stock bajo**.",
    "No tengo acceso a datos de ventas, así que no puedo decirte qué productos se venden más.",
    "Encontré tres presentaciones de Coca Cola: 1.5 L, 350 ml y Zero 400 ml. ¿Cuál te interesa?",
  ]) {
    assert.equal(inspectAssistantText(sample), null, sample);
  }
});

test("una tabla o un listado largo válidos no se confunden con repetición", () => {
  const names = [
    "Agua Cristal 600 ml", "Coca Cola 350 ml", "Coca Cola 1.5 L", "Pepsi 400 ml",
    "Jugo Hit Mango", "Té Hatsu Blanco", "Red Bull 250 ml", "Cerveza Águila",
    "Papas Margarita", "Doritos Mega Queso", "Cheetos 40 g", "Maní La Especial",
    "Chocoramo 65 g", "Galletas Oreo", "Bon Bon Bum", "Pan Tajado Bimbo",
    "Pan de Bono", "Almojábana", "Croissant", "Arepa de Queso",
  ];
  const categories = ["Bebidas", "Snacks", "Panadería"];
  const table = [
    "| **Producto** | **Categoría** | **Stock** | **Stock mínimo** | **Precio** | **Stock bajo** |",
    "|------------------------------|-----------------|-----------|------------------|------------|----------------|",
    ...names.slice(0, 10).map(
      (name, index) =>
        `| ${name.padEnd(28)} | ${categories[index % 3]} | ${(index * 7) % 50} | 5 | $${(index + 1) * 350} | ${(index * 7) % 50 <= 5 ? "Sí" : "No"} |`,
    ),
  ].join("\n");
  const list = names
    .map(
      (name, index) =>
        `${index + 1}. **${name}**\n   - Categoría: ${categories[index % 3]}\n   - Stock registrado: ${(index * 7) % 50} unidades\n   - Precio: $${(index + 1) * 300}`,
    )
    .join("\n\n");

  assert.equal(
    inspectAssistantText(`Aquí tienes 10 de los 49 productos:\n\n${table}\n\n¿Quieres ver la página 2?`),
    null,
  );
  assert.equal(inspectAssistantText(list), null);
});

test("una salida dañada se regenera una sola vez y se recupera", async () => {
  const { fetch: implementation, requests } = sequenceFetch([
    { status: 200, payload: textPayload(DAMAGED_OUTPUT) },
    { status: 200, payload: REAL_TEXT_PAYLOAD },
  ]);
  const client = new OllamaChatClient(CONFIG, implementation);

  const message = await client.complete([{ role: "user", content: "Hola" }], []);

  assert.match(message.content, /49 productos/u);
  assert.equal(requests(), 2);
});

test("dos salidas inválidas terminan en un error limpio sin la salida dañada", async () => {
  const { fetch: implementation, requests } = sequenceFetch([
    { status: 200, payload: textPayload(DAMAGED_OUTPUT) },
    { status: 200, payload: textPayload(LEAKED_TOOL_ERROR) },
    { status: 200, payload: REAL_TEXT_PAYLOAD },
  ]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await assert.rejects(
    () => client.complete([{ role: "user", content: "Hola" }], []),
    (error: unknown) =>
      error instanceof OllamaChatError &&
      error.code === "invalid_response" &&
      !/7812|invalid_input|\{/u.test(error.message),
  );
  assert.equal(requests(), 2);
});

test("done_reason length se rechaza aunque traiga texto", async () => {
  const { fetch: implementation, requests } = sequenceFetch([
    { status: 200, payload: textPayload("Aquí tienes los productos:\n1. Agua", "length") },
  ]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await assert.rejects(
    () => client.complete([{ role: "user", content: "Hola" }], []),
    (error: unknown) =>
      error instanceof OllamaChatError &&
      error.code === "truncated_response" &&
      !error.message.includes("Aquí tienes"),
  );
  assert.equal(requests(), 2);
});

test("un fallo de red se reintenta una sola vez", async () => {
  const { fetch: implementation, requests } = sequenceFetch([
    new TypeError("fetch failed"),
    { status: 200, payload: REAL_TEXT_PAYLOAD },
  ]);
  const client = new OllamaChatClient(CONFIG, implementation);

  const message = await client.complete([{ role: "user", content: "Hola" }], []);

  assert.match(message.content, /49 productos/u);
  assert.equal(requests(), 2);
});
