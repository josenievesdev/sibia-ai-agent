import assert from "node:assert/strict";
import test from "node:test";

import {
  OllamaChatClient,
  OllamaChatError,
  parseChatPayload,
  parseToolCalls,
} from "../src/integrations/ollama/chat-client.js";

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

test("declara num_ctx, temperatura única y no limita num_predict", async () => {
  const { fetch: implementation, bodies } = stubFetch([REAL_TEXT_PAYLOAD]);
  const client = new OllamaChatClient(CONFIG, implementation);

  await client.complete([{ role: "user", content: "Hola" }], []);

  const options = bodies[0]?.options as Record<string, unknown>;
  assert.equal(options.num_ctx, CONFIG.numCtx);
  assert.equal(options.temperature, 0.2);
  assert.equal("num_predict" in options, false);
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
