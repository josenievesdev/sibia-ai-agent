import assert from "node:assert/strict";
import test from "node:test";

import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  OllamaAssistantMessage,
  OllamaChatMessage,
} from "../src/ai/ollama-client.js";
import {
  StoreChatAgent,
  type ChatCompletionClient,
  type ChatTurnStatus,
} from "../src/ai/sibia-agent.js";
import {
  readBearerToken,
  SupabaseWebTokenVerifier,
  type WebIdentity,
  type WebTokenVerification,
  type WebTokenVerifier,
} from "../src/channels/web/web-auth.js";
import {
  SibiaWebAgentFactory,
  type WebAgentFactory,
  type WebConversationAgent,
  type WebConversationCreation,
} from "../src/channels/web/web-agent-factory.js";
import type { WebChannel } from "../src/channels/web/web-channel.js";
import { WebSessionManager } from "../src/channels/web/web-session-manager.js";
import { loadConfig } from "../src/config/env.js";
import { buildApp } from "../src/http/app.js";
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

function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.firma`;
}

const TOKEN_ANA = fakeJwt({ sub: "ana", session_id: "sesion-ana" });
const TOKEN_ANA_REFRESHED = fakeJwt({
  sub: "ana",
  session_id: "sesion-ana",
  iat: 2,
});
const TOKEN_ANA_OTHER_LOGIN = fakeJwt({ sub: "ana", session_id: "sesion-ana-2" });
const TOKEN_BRUNO = fakeJwt({ sub: "bruno", session_id: "sesion-bruno" });
const TOKEN_REJECTED = fakeJwt({ sub: "desconocido" });
const TOKEN_AUTH_DOWN = fakeJwt({ sub: "caida" });

class FakeVerifier implements WebTokenVerifier {
  calls = 0;

  async verify(accessToken: string): Promise<WebTokenVerification> {
    this.calls += 1;
    if (accessToken === TOKEN_AUTH_DOWN) {
      return { status: "unavailable" };
    }
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { sub: string; session_id?: string };
    if (accessToken === TOKEN_REJECTED) {
      return { status: "invalid" };
    }
    return {
      status: "valid",
      identity: { userId: payload.sub, sessionId: payload.session_id ?? null },
    };
  }
}

class RecordingAgent implements WebConversationAgent {
  readonly messages: string[] = [];

  constructor(
    private readonly reply: (
      message: string,
    ) => Promise<{ status: ChatTurnStatus; text: string }> = async (message) => ({
      status: "ok",
      text: `respuesta:${message}`,
    }),
  ) {}

  async respond(message: string): Promise<{ status: ChatTurnStatus; text: string }> {
    this.messages.push(message);
    return this.reply(message);
  }
}

class FakeAgentFactory implements WebAgentFactory {
  readonly agents: WebConversationAgent[] = [];
  readonly tokenSources: (() => string)[] = [];
  outcome: "forbidden" | "ready" | "unavailable" = "ready";

  constructor(
    private readonly build: () => WebConversationAgent = () => new RecordingAgent(),
  ) {}

  async createConversation(
    accessToken: () => string,
  ): Promise<WebConversationCreation> {
    this.tokenSources.push(accessToken);
    if (this.outcome !== "ready") {
      return { status: this.outcome };
    }
    const agent = this.build();
    this.agents.push(agent);
    return { status: "ready", agent };
  }
}

function createTestApp(
  factory: WebAgentFactory,
  sessionOptions: ConstructorParameters<typeof WebSessionManager>[1] = {},
) {
  const verifier = new FakeVerifier();
  const sessions = new WebSessionManager(factory, sessionOptions);
  const channel: WebChannel = {
    supabase: {
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_fake",
    },
    verifier,
    sessions,
  };
  const app = buildApp(loadConfig({}), { logger: false, webChannel: channel });
  return { app, sessions, verifier };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

test("la configuración web solo expone la URL y la publishable key", async () => {
  const { app } = createTestApp(new FakeAgentFactory());
  try {
    const response = await app.inject({ method: "GET", url: "/api/web/config" });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.deepEqual(response.json(), {
      status: "ok",
      supabase: {
        url: "https://example.supabase.co",
        publishableKey: "sb_publishable_fake",
      },
    });
  } finally {
    await app.close();
  }
});

test("sin Supabase configurado el canal web responde no disponible", async () => {
  const app = buildApp(loadConfig({}), { logger: false });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "hola" },
    });

    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, "WEB_NOT_CONFIGURED");
  } finally {
    await app.close();
  }
});

test("rechaza el chat sin token y no crea conversaciones", async () => {
  const factory = new FakeAgentFactory();
  const { app, verifier } = createTestApp(factory);
  try {
    const missing = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      payload: { message: "¿cuánto stock hay?" },
    });
    const malformed = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
      payload: { message: "¿cuánto stock hay?" },
    });

    assert.equal(missing.statusCode, 401);
    assert.equal(missing.json().code, "AUTH_REQUIRED");
    assert.equal(malformed.statusCode, 401);
    assert.equal(verifier.calls, 0);
    assert.equal(factory.tokenSources.length, 0);
  } finally {
    await app.close();
  }
});

test("rechaza un token inválido y distingue Supabase Auth no disponible", async () => {
  const factory = new FakeAgentFactory();
  const { app } = createTestApp(factory);
  try {
    const invalid = await app.inject({
      method: "POST",
      url: "/api/web/session",
      headers: bearer(TOKEN_REJECTED),
    });
    const down = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_AUTH_DOWN),
      payload: { message: "hola" },
    });

    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.json().code, "INVALID_TOKEN");
    assert.equal(down.statusCode, 503);
    assert.equal(factory.tokenSources.length, 0);
  } finally {
    await app.close();
  }
});

test("un usuario autenticado sin acceso administrativo no obtiene conversación", async () => {
  const factory = new FakeAgentFactory();
  factory.outcome = "forbidden";
  const { app, sessions } = createTestApp(factory);
  try {
    const session = await app.inject({
      method: "POST",
      url: "/api/web/session",
      headers: bearer(TOKEN_ANA),
    });
    const chat = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "hola" },
    });

    assert.equal(session.statusCode, 403);
    assert.equal(session.json().code, "ADMIN_ACCESS_REQUIRED");
    assert.equal(sessions.size, 0);
    assert.equal(chat.statusCode, 401);
    assert.equal(chat.json().code, "SESSION_NOT_FOUND");
  } finally {
    await app.close();
  }
});

test("envía una consulta y devuelve íntegra la respuesta del agente", async () => {
  const markdown = "| Producto | Precio |\n| --- | ---: |\n| Pan | $ 4.500 |";
  const agent = new RecordingAgent(async () => ({ status: "ok", text: markdown }));
  const factory = new FakeAgentFactory(() => agent);
  const { app } = createTestApp(factory);
  try {
    const session = await app.inject({
      method: "POST",
      url: "/api/web/session",
      headers: bearer(TOKEN_ANA),
    });
    const chat = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "  ¿Qué productos tienen menos existencias?  " },
    });

    assert.equal(session.statusCode, 200);
    assert.equal(chat.statusCode, 200);
    assert.deepEqual(chat.json(), {
      status: "ok",
      reply: { status: "ok", text: markdown },
    });
    assert.deepEqual(agent.messages, [
      "  ¿Qué productos tienen menos existencias?  ",
    ]);
  } finally {
    await app.close();
  }
});

test("valida el cuerpo del chat antes de llegar al agente", async () => {
  const agent = new RecordingAgent();
  const { app } = createTestApp(new FakeAgentFactory(() => agent));
  try {
    await app.inject({
      method: "POST",
      url: "/api/web/session",
      headers: bearer(TOKEN_ANA),
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: {},
    });
    const blank = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "   " },
    });

    assert.equal(missing.statusCode, 400);
    assert.equal(blank.statusCode, 400);
    assert.deepEqual(agent.messages, []);
  } finally {
    await app.close();
  }
});

test("dos usuarios conservan memorias separadas del agente existente", async () => {
  class CapturingModel implements ChatCompletionClient {
    readonly calls: OllamaChatMessage[][] = [];

    async complete(
      messages: readonly OllamaChatMessage[],
    ): Promise<OllamaAssistantMessage> {
      this.calls.push(messages.map((message) => ({ ...message })));
      const last = messages.findLast((message) => message.role === "user");
      return { role: "assistant", content: `Recibí: ${last?.content ?? ""}` };
    }
  }

  const model = new CapturingModel();
  const catalog = {
    definitions: [],
    async execute() {
      throw new Error("No debe ejecutar tools en esta prueba.");
    },
  } as unknown as StoreReadToolCatalog;
  const factory = new FakeAgentFactory(
    () => new StoreChatAgent(model, catalog, { businessName: "Tienda de Prueba" }),
  );
  const { app } = createTestApp(factory);
  try {
    for (const token of [TOKEN_ANA, TOKEN_BRUNO]) {
      await app.inject({ method: "POST", url: "/api/web/session", headers: bearer(token) });
    }
    await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "Busca agua de Ana" },
    });
    const bruno = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_BRUNO),
      payload: { message: "Pregunta de Bruno" },
    });
    await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "La segunda" },
    });

    assert.equal(bruno.json().reply.text, "Recibí: Pregunta de Bruno");
    const brunoContext = JSON.stringify(model.calls[1]);
    assert.doesNotMatch(brunoContext, /Ana/u);
    const anaSecondTurn = JSON.stringify(model.calls[2]);
    assert.match(anaSecondTurn, /Busca agua de Ana/u);
    assert.doesNotMatch(anaSecondTurn, /Bruno/u);
    assert.notEqual(factory.agents[0], factory.agents[1]);
  } finally {
    await app.close();
  }
});

test("un error del agente se informa sin cerrar la conversación", async () => {
  let failNext = true;
  const agent = new RecordingAgent(async (message) => {
    if (failNext) {
      failNext = false;
      throw new Error("fallo interno simulado");
    }
    return { status: "error", text: `Ollama no respondió a ${message}` };
  });
  const { app } = createTestApp(new FakeAgentFactory(() => agent));
  try {
    await app.inject({ method: "POST", url: "/api/web/session", headers: bearer(TOKEN_ANA) });
    const failed = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "primera" },
    });
    const reported = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "segunda" },
    });

    assert.equal(failed.statusCode, 502);
    assert.equal(failed.json().code, "AGENT_FAILED");
    assert.doesNotMatch(failed.body, /fallo interno/u);
    assert.equal(reported.statusCode, 200);
    assert.deepEqual(reported.json().reply, {
      status: "error",
      text: "Ollama no respondió a segunda",
    });
  } finally {
    await app.close();
  }
});

test("cerrar sesión destruye la memoria y un nuevo acceso empieza limpio", async () => {
  const factory = new FakeAgentFactory();
  const { app, sessions } = createTestApp(factory);
  try {
    await app.inject({ method: "POST", url: "/api/web/session", headers: bearer(TOKEN_ANA) });
    await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "antes de salir" },
    });

    const logout = await app.inject({
      method: "DELETE",
      url: "/api/web/session",
      headers: bearer(TOKEN_ANA),
    });
    const afterLogout = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "después de salir" },
    });

    assert.equal(logout.statusCode, 204);
    assert.equal(sessions.size, 0);
    assert.equal(afterLogout.statusCode, 401);

    await app.inject({ method: "POST", url: "/api/web/session", headers: bearer(TOKEN_ANA) });
    await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "nuevo acceso" },
    });
    assert.deepEqual((factory.agents[0] as RecordingAgent).messages, ["antes de salir"]);
    assert.deepEqual((factory.agents[1] as RecordingAgent).messages, ["nuevo acceso"]);
  } finally {
    await app.close();
  }
});

test("un nuevo inicio de sesión reemplaza la conversación anterior del usuario", async () => {
  const factory = new FakeAgentFactory();
  const { app } = createTestApp(factory);
  try {
    await app.inject({ method: "POST", url: "/api/web/session", headers: bearer(TOKEN_ANA) });
    await app.inject({
      method: "POST",
      url: "/api/web/session",
      headers: bearer(TOKEN_ANA_OTHER_LOGIN),
    });

    const oldLogin = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA),
      payload: { message: "desde la sesión anterior" },
    });
    const oldLogout = await app.inject({
      method: "DELETE",
      url: "/api/web/session",
      headers: bearer(TOKEN_ANA),
    });
    const newLogin = await app.inject({
      method: "POST",
      url: "/api/web/chat",
      headers: bearer(TOKEN_ANA_OTHER_LOGIN),
      payload: { message: "desde la sesión nueva" },
    });

    assert.equal(oldLogin.statusCode, 401);
    assert.equal(oldLogout.statusCode, 204);
    assert.equal(newLogin.statusCode, 200);
    assert.deepEqual((factory.agents[1] as RecordingAgent).messages, [
      "desde la sesión nueva",
    ]);
  } finally {
    await app.close();
  }
});

test("los turnos de un usuario se ejecutan en cola y se limita la espera", async () => {
  const release = deferred<void>();
  const started: string[] = [];
  const agent = new RecordingAgent(async (message) => {
    started.push(message);
    if (message === "primera") {
      await release.promise;
    }
    return { status: "ok", text: message };
  });
  const factory = new FakeAgentFactory(() => agent);
  const sessions = new WebSessionManager(factory, { maxPendingTurns: 2 });
  const ana: WebIdentity = { userId: "ana", sessionId: "sesion-ana" };

  assert.equal(await sessions.open(ana, TOKEN_ANA), "ready");
  const first = sessions.send(ana, TOKEN_ANA, "primera");
  const second = sessions.send(ana, TOKEN_ANA_REFRESHED, "segunda");
  const third = await sessions.send(ana, TOKEN_ANA, "tercera");
  await pause(5);

  assert.deepEqual(started, ["primera"]);
  assert.deepEqual(third, { status: "busy" });
  assert.equal(factory.tokenSources[0]?.(), TOKEN_ANA_REFRESHED);

  release.resolve(undefined);
  assert.deepEqual(await first, { status: "ok", reply: { status: "ok", text: "primera" } });
  assert.deepEqual(await second, { status: "ok", reply: { status: "ok", text: "segunda" } });
  assert.deepEqual(started, ["primera", "segunda"]);
  sessions.stop();
});

test("cerrar sesión durante un turno descarta la respuesta pendiente", async () => {
  const release = deferred<void>();
  const agent = new RecordingAgent(async () => {
    await release.promise;
    return { status: "ok", text: "respuesta tardía" };
  });
  const sessions = new WebSessionManager(new FakeAgentFactory(() => agent));
  const ana: WebIdentity = { userId: "ana", sessionId: "sesion-ana" };

  await sessions.open(ana, TOKEN_ANA);
  const pending = sessions.send(ana, TOKEN_ANA, "consulta");
  await pause(1);
  assert.equal(sessions.close(ana), true);
  release.resolve(undefined);

  assert.deepEqual(await pending, { status: "closed" });
  assert.equal(sessions.size, 0);
});

test("la limpieza elimina conversaciones inactivas y respeta las ocupadas", async () => {
  let now = 0;
  const release = deferred<void>();
  const factory = new FakeAgentFactory(
    () =>
      new RecordingAgent(async (message) => {
        if (message === "lenta") {
          await release.promise;
        }
        return { status: "ok", text: message };
      }),
  );
  const sessions = new WebSessionManager(factory, {
    idleTimeoutMs: 1_000,
    now: () => now,
  });
  const ana: WebIdentity = { userId: "ana", sessionId: "a" };
  const bruno: WebIdentity = { userId: "bruno", sessionId: "b" };

  await sessions.open(ana, TOKEN_ANA);
  await sessions.open(bruno, TOKEN_BRUNO);
  const busy = sessions.send(bruno, TOKEN_BRUNO, "lenta");
  now = 5_000;
  sessions.sweep();

  assert.equal(sessions.size, 1);
  assert.deepEqual(await sessions.send(ana, TOKEN_ANA, "hola"), { status: "no_session" });
  release.resolve(undefined);
  await busy;
  now = 7_000;
  sessions.sweep();
  assert.equal(sessions.size, 0);
});

test("la fábrica usa el JWT vigente del usuario y la comprobación de acceso existente", async () => {
  const connections: { accessToken: (() => Promise<string | null>) | undefined }[] = [];
  const fakeClient = {} as SupabaseClient;
  let accessStatus: "authorized" | "error" | "forbidden" = "forbidden";
  const factory = new SibiaWebAgentFactory(
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
    },
    {
      createConnection: (_config, options) => {
        connections.push({ accessToken: options?.accessToken });
        return fakeClient;
      },
      checkAccess: async (client) => {
        assert.equal(client, fakeClient);
        return { status: accessStatus, code: "PRUEBA", message: "prueba" };
      },
      model: {
        async complete() {
          return { role: "assistant", content: "respuesta" };
        },
      },
    },
  );

  let token = TOKEN_ANA;
  assert.deepEqual(await factory.createConversation(() => token), { status: "forbidden" });
  accessStatus = "error";
  assert.deepEqual(await factory.createConversation(() => token), { status: "unavailable" });
  accessStatus = "authorized";
  const ready = await factory.createConversation(() => token);

  assert.equal(ready.status, "ready");
  assert.ok(ready.status === "ready" && ready.agent instanceof StoreChatAgent);
  token = TOKEN_ANA_REFRESHED;
  assert.equal(await connections[2]?.accessToken?.(), TOKEN_ANA_REFRESHED);
});

test("el verificador consulta Supabase Auth con el token y clasifica los fallos", async () => {
  const received: string[] = [];
  let outcome: "down" | "rejected" | "valid" = "valid";
  const fakeClient = {
    auth: {
      async getUser(jwt: string) {
        received.push(jwt);
        if (outcome === "rejected") {
          return { data: { user: null }, error: { name: "AuthApiError", status: 403 } };
        }
        if (outcome === "down") {
          return {
            data: { user: null },
            error: { name: "AuthRetryableFetchError", status: 0 },
          };
        }
        return { data: { user: { id: "ana" } }, error: null };
      },
    },
  } as unknown as SupabaseClient;
  let persistence: unknown = "sin opción";
  const verifier = new SupabaseWebTokenVerifier(
    { url: "https://example.supabase.co", publishableKey: "sb_publishable_fake" },
    100,
    (_config, options) => {
      persistence = options?.accessToken;
      return fakeClient;
    },
  );

  assert.deepEqual(await verifier.verify(TOKEN_ANA), {
    status: "valid",
    identity: { userId: "ana", sessionId: "sesion-ana" },
  });
  outcome = "rejected";
  assert.deepEqual(await verifier.verify(TOKEN_ANA), { status: "invalid" });
  outcome = "down";
  assert.deepEqual(await verifier.verify(TOKEN_ANA), { status: "unavailable" });
  assert.deepEqual(received, [TOKEN_ANA, TOKEN_ANA, TOKEN_ANA]);
  assert.equal(persistence, undefined);
});

test("solo acepta cabeceras Bearer con forma de JWT", () => {
  assert.equal(readBearerToken(`Bearer ${TOKEN_ANA}`), TOKEN_ANA);
  assert.equal(readBearerToken(undefined), null);
  assert.equal(readBearerToken("Bearer"), null);
  assert.equal(readBearerToken("Bearer no-es-un-jwt"), null);
  assert.equal(readBearerToken(`Token ${TOKEN_ANA}`), null);
  assert.equal(readBearerToken(`Bearer ${TOKEN_ANA} extra`), null);
});
