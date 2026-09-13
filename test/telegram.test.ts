import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  StoreChatAgent,
  type ChatCompletionClient,
} from "../src/ai/sibia-agent.js";
import {
  OllamaChatError,
  type OllamaAssistantMessage,
  type OllamaChatMessage,
} from "../src/ai/ollama-client.js";
import {
  TelegramBot,
  type TelegramAgentFactory,
  type TelegramConversationAgent,
} from "../src/channels/telegram/bot.js";
import {
  TelegramApiError,
  TelegramHttpClient,
  type TelegramClient,
  type TelegramUpdate,
} from "../src/channels/telegram/client.js";
import { loadTelegramConfig } from "../src/channels/telegram/config.js";
import {
  formatTelegramText,
  splitTelegramText,
  TELEGRAM_TEXT_LIMIT,
} from "../src/channels/telegram/format.js";
import {
  TelegramAgentFactoryError,
  TelegramSibiaAgentFactory,
} from "../src/channels/telegram/sibia-agent-factory.js";
import { ConfigurationError, loadConfig } from "../src/config/env.js";
import type { StoreReadToolCatalog } from "../src/tools/store-read-tool-catalog.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function textUpdate(
  updateId: number,
  userId: number,
  text: string,
  chatType = "private",
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: userId, type: chatType },
      from: { id: userId },
      text,
    },
  };
}

function photoUpdate(updateId: number, userId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: userId, type: "private" },
      from: { id: userId },
      photo: [{ file_id: "fake" }],
    },
  };
}

class RecordingAgent implements TelegramConversationAgent {
  readonly messages: string[] = [];

  constructor(
    readonly name: string,
    private readonly reply: (message: string) => Promise<string> = async (
      message,
    ) => `${name}:${message}`,
  ) {}

  async respond(message: string): Promise<{ text: string }> {
    this.messages.push(message);
    return { text: await this.reply(message) };
  }
}

class FakeAgentFactory implements TelegramAgentFactory {
  readonly agents: TelegramConversationAgent[] = [];
  initializeCalls = 0;
  createCalls = 0;
  closeCalls = 0;
  initializationError: Error | null = null;
  creationError: Error | null = null;

  constructor(
    private readonly build: (index: number) => TelegramConversationAgent = (
      index,
    ) => new RecordingAgent(`agent-${index + 1}`),
  ) {}

  async initialize(): Promise<void> {
    this.initializeCalls += 1;
    if (this.initializationError !== null) {
      throw this.initializationError;
    }
  }

  async createAgent(): Promise<TelegramConversationAgent> {
    this.createCalls += 1;
    if (this.creationError !== null) {
      throw this.creationError;
    }
    const agent = this.build(this.agents.length);
    this.agents.push(agent);
    return agent;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class FakeTelegramClient implements TelegramClient {
  readonly messages: { chatId: number; text: string }[] = [];
  readonly actions: { chatId: number; action: "typing" }[] = [];
  messageAttempts = 0;
  messageFailures = 0;
  actionFailures = 0;

  async getUpdates(): Promise<readonly TelegramUpdate[]> {
    throw new Error("El polling no está configurado para esta prueba.");
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    this.messageAttempts += 1;
    if (this.messageFailures > 0) {
      this.messageFailures -= 1;
      throw new TelegramApiError(
        "connection_error",
        "Fallo simulado de Telegram.",
      );
    }
    this.messages.push({ chatId, text });
  }

  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    if (this.actionFailures > 0) {
      this.actionFailures -= 1;
      throw new TelegramApiError(
        "connection_error",
        "Fallo simulado de Telegram.",
      );
    }
    this.actions.push({ chatId, action });
  }
}

function createBot(
  client: TelegramClient,
  factory: TelegramAgentFactory,
  allowedUserIds: readonly number[],
  typingIntervalMs = 5,
): TelegramBot {
  return new TelegramBot(client, factory, {
    allowedUserIds: new Set(allowedUserIds),
    businessName: "Tienda de Prueba",
    pollingErrorDelayMs: 1,
    typingIntervalMs,
  });
}

const TELEGRAM_ENV: NodeJS.ProcessEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fake",
  TELEGRAM_ALLOWED_USER_IDS: "101, 202",
  TELEGRAM_BOT_TOKEN: "123456:fake_token",
  TELEGRAM_SUPABASE_EMAIL: "bot@example.com",
  TELEGRAM_SUPABASE_PASSWORD: "fake-password",
};

test("la configuración de Telegram solo se exige para su propio comando", () => {
  assert.doesNotThrow(() => loadConfig({}));
  assert.throws(() => loadTelegramConfig({}), ConfigurationError);

  const config = loadTelegramConfig(TELEGRAM_ENV);
  assert.deepEqual([...config.allowedUserIds], [101, 202]);
  assert.equal(config.app.ollama.model, "ministral-3:8b");
});

test("una lista de autorizados vacía permite iniciar únicamente para descubrir /id", () => {
  const config = loadTelegramConfig({
    ...TELEGRAM_ENV,
    TELEGRAM_ALLOWED_USER_IDS: "",
  });

  assert.equal(config.allowedUserIds.size, 0);
});

test("rechaza IDs inválidos sin incluir secretos en el error", () => {
  assert.throws(
    () =>
      loadTelegramConfig({
        ...TELEGRAM_ENV,
        TELEGRAM_ALLOWED_USER_IDS: "101,abc",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.doesNotMatch(error.message, /fake-password|fake_token/u);
      return true;
    },
  );
});

test("/id devuelve únicamente el ID incluso antes de autorizar al usuario", async () => {
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory();
  const bot = createBot(client, factory, []);

  await bot.handleUpdate(textUpdate(1, 987654321, "/id"));

  assert.deepEqual(client.messages, [
    { chatId: 987654321, text: "987654321" },
  ]);
  assert.equal(factory.createCalls, 0);
});

test("un usuario no autorizado no ejecuta SIBIA y uno autorizado sí", async () => {
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory();
  const bot = createBot(client, factory, [20]);

  await bot.handleUpdate(textUpdate(1, 10, "Dime el inventario"));
  await bot.handleUpdate(textUpdate(2, 20, "Dime el inventario"));

  assert.equal(factory.createCalls, 1);
  assert.deepEqual((factory.agents[0] as RecordingAgent).messages, [
    "Dime el inventario",
  ]);
  assert.match(client.messages[0]?.text ?? "", /no está autorizado/u);
  assert.equal(client.messages[1]?.text, "agent-1:Dime el inventario");
});

test("/start y /ayuda describen solo las capacidades reales sin invocar el agente", async () => {
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory();
  const bot = createBot(client, factory, [10]);

  await bot.handleUpdate(textUpdate(1, 10, "/start"));
  await bot.handleUpdate(textUpdate(2, 10, "/ayuda"));

  assert.equal(factory.createCalls, 0);
  assert.match(client.messages[0]?.text ?? "", /SIBIA.*Tienda de Prueba/u);
  assert.match(client.messages[1]?.text ?? "", /productos y precios/u);
  assert.match(client.messages[1]?.text ?? "", /\/reiniciar/u);
});

test("cada usuario conserva memoria aislada y reinicia o sale solo de su sesión", async () => {
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory(
    (index) =>
      new RecordingAgent(`agent-${index + 1}`, async function reply(message) {
        return `${this.name}:${this.messages.join("|")}:${message}`;
      }),
  );
  const bot = createBot(client, factory, [10, 20]);

  await bot.handleUpdate(textUpdate(1, 10, "uno"));
  await bot.handleUpdate(textUpdate(2, 20, "dos"));
  await bot.handleUpdate(textUpdate(3, 10, "tres"));
  await bot.handleUpdate(textUpdate(4, 10, "/reiniciar"));
  await bot.handleUpdate(textUpdate(5, 10, "cuatro"));
  await bot.handleUpdate(textUpdate(6, 20, "cinco"));
  await bot.handleUpdate(textUpdate(7, 20, "/salir"));
  await bot.handleUpdate(textUpdate(8, 20, "seis"));

  assert.equal(factory.createCalls, 4);
  assert.deepEqual((factory.agents[0] as RecordingAgent).messages, ["uno", "tres"]);
  assert.deepEqual((factory.agents[1] as RecordingAgent).messages, ["dos", "cinco"]);
  assert.deepEqual((factory.agents[2] as RecordingAgent).messages, ["cuatro"]);
  assert.deepEqual((factory.agents[3] as RecordingAgent).messages, ["seis"]);
  assert.match(client.messages[3]?.text ?? "", /reiniciada/u);
  assert.match(client.messages[6]?.text ?? "", /Hasta luego/u);
});

test("procesa secuencialmente los mensajes de un mismo usuario", async () => {
  const firstTurn = deferred<void>();
  const started: string[] = [];
  const agent = new RecordingAgent("sequential", async (message) => {
    started.push(message);
    if (message === "primero") {
      await firstTurn.promise;
    }
    return message;
  });
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory(() => agent);
  const bot = createBot(client, factory, [10]);

  const first = bot.handleUpdate(textUpdate(1, 10, "primero"));
  const second = bot.handleUpdate(textUpdate(2, 10, "segundo"));
  await pause(10);

  assert.deepEqual(started, ["primero"]);
  firstTurn.resolve(undefined);
  await Promise.all([first, second]);
  assert.deepEqual(started, ["primero", "segundo"]);
  assert.deepEqual(
    client.messages.map((entry) => entry.text),
    ["primero", "segundo"],
  );
});

test("envía typing periódicamente y lo detiene al terminar el turno", async () => {
  const turn = deferred<string>();
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory(
    () => new RecordingAgent("typing", async () => turn.promise),
  );
  const bot = createBot(client, factory, [10], 3);

  const pending = bot.handleUpdate(textUpdate(1, 10, "consulta lenta"));
  await pause(16);
  assert.ok(client.actions.length >= 2);

  turn.resolve("respuesta");
  await pending;
  const actionsAtCompletion = client.actions.length;
  await pause(10);
  assert.equal(client.actions.length, actionsAtCompletion);
});

test("deduplica update_id antes de ejecutar el agente", async () => {
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory();
  const bot = createBot(client, factory, [10]);
  const update = textUpdate(55, 10, "una sola vez");

  await Promise.all([bot.handleUpdate(update), bot.handleUpdate(update)]);

  assert.deepEqual((factory.agents[0] as RecordingAgent).messages, [
    "una sola vez",
  ]);
  assert.equal(client.messages.length, 1);
});

test("ignora chats no privados y explica que los archivos aún no se procesan", async () => {
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory();
  const bot = createBot(client, factory, [10]);

  await bot.handleUpdate(textUpdate(1, 10, "/id", "group"));
  await bot.handleUpdate(photoUpdate(2, 10));

  assert.equal(factory.createCalls, 0);
  assert.equal(client.messages.length, 1);
  assert.match(client.messages[0]?.text ?? "", /únicamente mensajes de texto/u);
});

test("entrega el texto normal íntegro al adaptador de StoreChatAgent existente", async () => {
  class CapturingModel implements ChatCompletionClient {
    readonly calls: OllamaChatMessage[][] = [];

    async complete(
      messages: readonly OllamaChatMessage[],
    ): Promise<OllamaAssistantMessage> {
      this.calls.push(messages.map((message) => ({ ...message })));
      return { role: "assistant", content: "**Respuesta segura**" };
    }
  }

  const model = new CapturingModel();
  const catalog = {
    definitions: [],
    async execute() {
      throw new Error("No debe ejecutar tools en esta prueba.");
    },
  } as unknown as StoreReadToolCatalog;
  const agent = new StoreChatAgent(model, catalog, {
    businessName: "Tienda de Prueba",
  });
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory(() => agent);
  const bot = createBot(client, factory, [10]);

  await bot.handleUpdate(textUpdate(1, 10, "consulta normal"));

  const userMessage = model.calls[0]?.findLast((message) => message.role === "user");
  assert.equal(userMessage?.content, "consulta normal");
  assert.equal(client.messages[0]?.text, "Respuesta segura");
});

test("los mensajes no reconocidos como comandos se entregan sin modificarlos", async () => {
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory();
  const bot = createBot(client, factory, [10]);
  const original = "  /comando_desconocido\ncon argumentos  ";

  await bot.handleUpdate(textUpdate(1, 10, original));

  assert.deepEqual((factory.agents[0] as RecordingAgent).messages, [original]);
});

test("divide respuestas extensas sin superar el límite ni cortar palabras", async () => {
  const longText = Array.from(
    { length: 1_200 },
    (_, index) => `producto-${index + 1}`,
  ).join(" ");
  const chunks = splitTelegramText(longText);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= TELEGRAM_TEXT_LIMIT));
  assert.equal(chunks.join(" "), longText);

  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory(
    () => new RecordingAgent("long", async () => longText),
  );
  const bot = createBot(client, factory, [10]);
  await bot.handleUpdate(textUpdate(1, 10, "lista extensa"));
  assert.deepEqual(
    client.messages.map((entry) => entry.text),
    chunks,
  );
});

test("convierte Markdown y tablas anchas a texto móvil conservando los datos", () => {
  const markdown = [
    "### Productos",
    "",
    "| Nombre | Precio | Cantidad | Estado |",
    "| --- | ---: | ---: | :--- |",
    "| Pan **integral** | $4.500 | 2 unidades | activo |",
    "| Bebida A \\| B | `$3.200` | `__SKU__` | activo |",
    "",
    "Consulta [la ficha](https://example.com/ficha).",
  ].join("\n");

  const text = formatTelegramText(markdown);

  assert.match(text, /^Productos/u);
  assert.match(text, /- Nombre: Pan integral/u);
  assert.match(text, /Precio: \$4\.500/u);
  assert.match(text, /Cantidad: 2 unidades/u);
  assert.match(text, /- Nombre: Bebida A \| B/u);
  assert.match(text, /Precio: \$3\.200/u);
  assert.match(text, /Cantidad: __SKU__/u);
  assert.match(text, /la ficha \(https:\/\/example\.com\/ficha\)/u);
  assert.doesNotMatch(text, /\*\*|\| ---/u);

  const literals = formatTelegramText(
    [
      "Código PROD_item_ABC y cálculo 2 * 3 * 4.",
      "```text",
      "| literal | dentro |",
      "| --- | --- |",
      "```",
    ].join("\n"),
  );
  assert.match(literals, /PROD_item_ABC/u);
  assert.match(literals, /2 \* 3 \* 4/u);
  assert.match(literals, /\| --- \| --- \|/u);

  const protectedText = formatTelegramText(
    "`__SKU__` REF-_A_ [privado](https://example.com/_privado_)",
  );
  assert.equal(
    protectedText,
    "__SKU__ REF-_A_ privado (https://example.com/_privado_)",
  );
});

test("el cliente HTTP no usa parse_mode y reintenta Telegram con backoff", async () => {
  const requests: RequestInit[] = [];
  const delays: number[] = [];
  let call = 0;
  const implementation = (async (_url: unknown, init?: RequestInit) => {
    requests.push(init ?? {});
    call += 1;
    return call === 1
      ? new Response(JSON.stringify({ ok: false, error_code: 503 }), {
          status: 503,
        })
      : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
  }) as unknown as typeof fetch;
  const client = new TelegramHttpClient("123456:fake_token", {
    fetchImplementation: implementation,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  await client.sendMessage(10, "<b>texto plano</b>");

  assert.equal(requests.length, 2);
  assert.deepEqual(delays, [300]);
  const body = JSON.parse(String(requests[1]?.body)) as Record<string, unknown>;
  assert.equal(body.text, "<b>texto plano</b>");
  assert.equal("parse_mode" in body, false);
});

test("el cliente aplica timeout y nunca propaga el token en errores", async () => {
  const token = "123456:secret_never_exposed";
  const hangingFetch = ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === null || signal === undefined) {
        reject(new Error("Falta señal"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Abortado", "AbortError")),
        { once: true },
      );
    })) as unknown as typeof fetch;
  const client = new TelegramHttpClient(token, {
    fetchImplementation: hangingFetch,
    maxAttempts: 1,
    requestTimeoutMs: 5,
  });

  await assert.rejects(client.sendMessage(10, "hola"), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.code, "timeout");
    assert.doesNotMatch(error.message, new RegExp(token, "u"));
    return true;
  });
});

test("respeta retry_after completo y permite cancelar el backoff del polling", async () => {
  const delays: number[] = [];
  let rateLimitCalls = 0;
  const rateLimitedFetch = (async () => {
    rateLimitCalls += 1;
    return rateLimitCalls === 1
      ? new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 45 },
          }),
          { status: 429 },
        )
      : new Response(JSON.stringify({ ok: true, result: true }), {
          status: 200,
        });
  }) as unknown as typeof fetch;
  const rateLimited = new TelegramHttpClient("123456:fake_token", {
    fetchImplementation: rateLimitedFetch,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  await rateLimited.sendChatAction(10, "typing");
  assert.deepEqual(delays, [45_000]);

  const persistentDelays: number[] = [];
  const persistentlyRateLimited = new TelegramHttpClient(
    "123456:fake_token",
    {
      fetchImplementation: (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            parameters: { retry_after: 45 },
          }),
          { status: 429 },
        )) as unknown as typeof fetch,
      maxAttempts: 2,
      sleep: async (milliseconds) => {
        persistentDelays.push(milliseconds);
      },
    },
  );
  await assert.rejects(
    persistentlyRateLimited.sendChatAction(10, "typing"),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.retryAfterMs, 45_000);
      return true;
    },
  );
  assert.deepEqual(persistentDelays, [45_000]);

  const unavailableFetch = (async () =>
    new Response(JSON.stringify({ ok: false, error_code: 503 }), {
      status: 503,
    })) as unknown as typeof fetch;
  const polling = new TelegramHttpClient("123456:fake_token", {
    fetchImplementation: unavailableFetch,
  });
  const controller = new AbortController();
  const pending = polling.getUpdates(0, controller.signal);
  await pause(5);
  controller.abort();

  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.code, "aborted");
    return true;
  });

  let bodyCalls = 0;
  const interruptedBody = new TelegramHttpClient("123456:fake_token", {
    fetchImplementation: (async () => {
      bodyCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          throw new TypeError("Socket interrumpido");
        },
      } as Response;
    }) as unknown as typeof fetch,
    maxAttempts: 2,
    sleep: async () => undefined,
  });
  await assert.rejects(
    interruptedBody.getUpdates(0, new AbortController().signal),
    (error: unknown) => {
      assert.ok(error instanceof TelegramApiError);
      assert.equal(error.code, "connection_error");
      assert.equal(error.retryable, true);
      return true;
    },
  );
  assert.equal(bodyCalls, 2);
});

test("un fallo de Ollama se comunica sin detener los turnos siguientes", async () => {
  class RecoveringModel implements ChatCompletionClient {
    calls = 0;

    async complete(): Promise<OllamaAssistantMessage> {
      this.calls += 1;
      if (this.calls === 1) {
        throw new OllamaChatError("connection_error", "No fue posible conectar con Ollama.");
      }
      return { role: "assistant", content: "Ollama volvió a estar disponible." };
    }
  }

  const catalog = {
    definitions: [],
    async execute() {
      throw new Error("No debe ejecutar tools en esta prueba.");
    },
  } as unknown as StoreReadToolCatalog;
  const agent = new StoreChatAgent(new RecoveringModel(), catalog);
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory(() => agent);
  const bot = createBot(client, factory, [10]);

  await bot.handleUpdate(textUpdate(1, 10, "primera"));
  await bot.handleUpdate(textUpdate(2, 10, "segunda"));

  assert.match(client.messages[0]?.text ?? "", /Ollama/u);
  assert.equal(client.messages[1]?.text, "Ollama volvió a estar disponible.");
});

test("un fallo de Supabase no detiene el bot ni expone detalles internos", async () => {
  const client = new FakeTelegramClient();
  const factory = new FakeAgentFactory();
  factory.creationError = new TelegramAgentFactoryError(
    "connection_error",
    "detalle interno simulado",
  );
  const bot = createBot(client, factory, [10]);

  await bot.handleUpdate(textUpdate(1, 10, "consulta"));
  await bot.handleUpdate(textUpdate(2, 10, "/id"));

  assert.match(client.messages[0]?.text ?? "", /no está disponible/u);
  assert.doesNotMatch(client.messages[0]?.text ?? "", /detalle interno/u);
  assert.equal(client.messages[1]?.text, "10");
});

test("un error de envío de Telegram queda contenido y el usuario siguiente se procesa", async () => {
  const client = new FakeTelegramClient();
  client.messageFailures = 1;
  const factory = new FakeAgentFactory();
  const bot = createBot(client, factory, [10]);

  await bot.handleUpdate(textUpdate(1, 10, "primera"));
  await bot.handleUpdate(textUpdate(2, 10, "segunda"));

  assert.equal(factory.createCalls, 2);
  assert.deepEqual((factory.agents[0] as RecordingAgent).messages, ["primera"]);
  assert.deepEqual((factory.agents[1] as RecordingAgent).messages, ["segunda"]);
  assert.equal(client.messageAttempts, 2);
  assert.equal(client.messages.length, 1);
  assert.equal(client.messages.at(-1)?.text, "agent-2:segunda");
});

test("la fábrica autentica una cuenta dedicada, crea agentes distintos y cierra sesión", async () => {
  let signIns = 0;
  let signOuts = 0;
  let disposals = 0;
  let autoRefresh: boolean | undefined;
  let requestTimeoutMs: number | undefined;
  const fakeClient = {
    auth: {
      async signInWithPassword() {
        signIns += 1;
        return { data: {}, error: null };
      },
      async signOut() {
        signOuts += 1;
        return { error: null };
      },
      async dispose() {
        disposals += 1;
      },
    },
  } as unknown as SupabaseClient;
  const model: ChatCompletionClient = {
    async complete() {
      return { role: "assistant", content: "respuesta" };
    },
  };
  const factory = new TelegramSibiaAgentFactory(
    {
      businessName: "Tienda de Prueba",
      integrationCheckTimeoutMs: 100,
      ollama: {
        baseUrl: "http://127.0.0.1:11434",
        chatTimeoutMs: 1_000,
        debug: false,
        model: "ministral-3:8b",
        numCtx: 6_144,
      },
      supabase: {
        url: "https://example.supabase.co",
        publishableKey: "sb_publishable_fake",
      },
      supabaseEmail: "bot@example.com",
      supabasePassword: "fake-password",
    },
    {
      checkAccess: async () => ({
        status: "authorized",
        code: "ADMIN_ACCESS_AUTHORIZED",
        message: "Acceso confirmado.",
      }),
      createConnection: (_config, options) => {
        autoRefresh = options?.autoRefreshToken;
        requestTimeoutMs = options?.requestTimeoutMs;
        return fakeClient;
      },
      model,
    },
  );

  await factory.initialize();
  const first = await factory.createAgent();
  const second = await factory.createAgent();
  await factory.close();

  assert.equal(signIns, 1);
  assert.equal(signOuts, 1);
  assert.equal(disposals, 1);
  assert.equal(autoRefresh, true);
  assert.equal(requestTimeoutMs, 100);
  assert.ok(first instanceof StoreChatAgent);
  assert.ok(second instanceof StoreChatAgent);
  assert.notEqual(first, second);
});

test("un fallo de Supabase Auth dispone el cliente falso y queda clasificado", async () => {
  let disposals = 0;
  let signIns = 0;
  const fakeClient = {
    auth: {
      async signInWithPassword() {
        signIns += 1;
        return {
          data: {},
          error: { name: "AuthRetryableFetchError", status: 503 },
        };
      },
      async signOut() {
        throw new Error("No debe cerrar una sesión que no se abrió.");
      },
      async dispose() {
        disposals += 1;
      },
    },
  } as unknown as SupabaseClient;
  const factory = new TelegramSibiaAgentFactory(
    {
      businessName: "Tienda de Prueba",
      integrationCheckTimeoutMs: 100,
      ollama: {
        baseUrl: "http://127.0.0.1:11434",
        chatTimeoutMs: 1_000,
        debug: false,
        model: "ministral-3:8b",
        numCtx: 6_144,
      },
      supabase: {
        url: "https://example.supabase.co",
        publishableKey: "sb_publishable_fake",
      },
      supabaseEmail: "bot@example.com",
      supabasePassword: "fake-password",
    },
    { createConnection: () => fakeClient },
  );

  await assert.rejects(factory.initialize(), (error: unknown) => {
    assert.ok(error instanceof TelegramAgentFactoryError);
    assert.equal(error.code, "connection_error");
    assert.doesNotMatch(error.message, /fake-password/u);
    return true;
  });
  await assert.rejects(factory.initialize(), TelegramAgentFactoryError);
  assert.equal(signIns, 1);
  assert.equal(disposals, 1);
  await factory.close();
});

test("el polling no confirma el siguiente offset hasta terminar el lote", async () => {
  const turnStarted = deferred<void>();
  const releaseTurn = deferred<void>();
  const secondPoll = deferred<void>();

  class BatchClient extends FakeTelegramClient {
    readonly offsets: number[] = [];

    override async getUpdates(
      offset: number,
      signal: AbortSignal,
      timeoutSeconds?: number,
    ): Promise<readonly TelegramUpdate[]> {
      this.offsets.push(offset);
      if (timeoutSeconds === 0) {
        return [];
      }
      if (this.offsets.length === 1) {
        return [textUpdate(70, 10, "consulta pendiente")];
      }
      secondPoll.resolve(undefined);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new TelegramApiError("aborted", "Prueba terminada.")),
          { once: true },
        );
      });
    }
  }

  const client = new BatchClient();
  const factory = new FakeAgentFactory(
    () =>
      new RecordingAgent("batch", async () => {
        turnStarted.resolve(undefined);
        await releaseTurn.promise;
        return "respuesta";
      }),
  );
  const bot = createBot(client, factory, [10]);
  const controller = new AbortController();
  const running = bot.run(controller.signal);

  await turnStarted.promise;
  await pause(5);
  assert.deepEqual(client.offsets, [0]);

  releaseTurn.resolve(undefined);
  await secondPoll.promise;
  assert.deepEqual(client.offsets, [0, 71]);
  controller.abort();
  await running;
  assert.equal(factory.closeCalls, 1);
});

test("al apagar omite turnos no iniciados y confirma solo el prefijo completado", async () => {
  const turnStarted = deferred<void>();
  const releaseTurn = deferred<void>();

  class ShutdownBatchClient extends FakeTelegramClient {
    readonly polls: { offset: number; timeoutSeconds: number | undefined }[] = [];

    override async getUpdates(
      offset: number,
      _signal: AbortSignal,
      timeoutSeconds?: number,
    ): Promise<readonly TelegramUpdate[]> {
      this.polls.push({ offset, timeoutSeconds });
      if (timeoutSeconds === 0) {
        return [];
      }
      if (this.polls.length === 1) {
        return [
          textUpdate(1, 10, "primero"),
          textUpdate(2, 10, "segundo"),
        ];
      }
      throw new Error("No debe iniciar otro long poll durante el apagado.");
    }
  }

  const agent = new RecordingAgent("shutdown", async (message) => {
    if (message === "primero") {
      turnStarted.resolve(undefined);
      await releaseTurn.promise;
    }
    return message;
  });
  const client = new ShutdownBatchClient();
  const factory = new FakeAgentFactory(() => agent);
  const bot = createBot(client, factory, [10]);
  const controller = new AbortController();
  const running = bot.run(controller.signal);

  await turnStarted.promise;
  controller.abort();
  releaseTurn.resolve(undefined);
  await running;

  assert.deepEqual(agent.messages, ["primero"]);
  assert.deepEqual(client.polls, [
    { offset: 0, timeoutSeconds: undefined },
    { offset: 2, timeoutSeconds: 0 },
  ]);
  assert.equal(factory.closeCalls, 1);
});

test("un error permanente de polling detiene limpiamente y cierra recursos", async () => {
  class UnauthorizedPollingClient extends FakeTelegramClient {
    override async getUpdates(): Promise<readonly TelegramUpdate[]> {
      throw new TelegramApiError(
        "http_error",
        "Telegram respondió con HTTP 401.",
        false,
      );
    }
  }

  const factory = new FakeAgentFactory();
  const bot = createBot(new UnauthorizedPollingClient(), factory, [10]);
  const controller = new AbortController();

  await assert.rejects(bot.run(controller.signal), TelegramApiError);
  assert.equal(factory.closeCalls, 1);
});

test("el polling supera un error transitorio y se apaga con AbortSignal", async () => {
  const pollingStarted = deferred<void>();

  class PollingClient extends FakeTelegramClient {
    calls = 0;

    override async getUpdates(
      _offset: number,
      signal: AbortSignal,
    ): Promise<readonly TelegramUpdate[]> {
      this.calls += 1;
      if (this.calls === 1) {
        throw new TelegramApiError(
          "connection_error",
          "Fallo transitorio simulado.",
        );
      }
      pollingStarted.resolve(undefined);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              new TelegramApiError("aborted", "Polling detenido para la prueba."),
            ),
          { once: true },
        );
      });
    }
  }

  const client = new PollingClient();
  const factory = new FakeAgentFactory();
  const bot = createBot(client, factory, [10]);
  const controller = new AbortController();
  const running = bot.run(controller.signal);

  await pollingStarted.promise;
  controller.abort();
  await running;

  assert.equal(client.calls, 2);
  assert.equal(factory.initializeCalls, 1);
  assert.equal(factory.closeCalls, 1);
});

test("un fallo de typing no impide que SIBIA responda", async () => {
  const client = new FakeTelegramClient();
  client.actionFailures = 1;
  const factory = new FakeAgentFactory();
  const bot = createBot(client, factory, [10]);

  await bot.handleUpdate(textUpdate(1, 10, "consulta"));

  assert.equal(client.messages[0]?.text, "agent-1:consulta");
});
