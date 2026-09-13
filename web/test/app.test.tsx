import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "../src/App";
import { ApiError, type AgentReply, type SibiaApi } from "../src/lib/api-client";
import type { AuthService, SignInResult } from "../src/lib/auth";
import { WELCOME_GREETINGS } from "../src/lib/welcome";

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

class FakeAuth implements AuthService {
  readonly signInEmails: string[] = [];
  signOutCalls = 0;
  token: string | null = null;
  nextSignIn: () => Promise<SignInResult> = async () => ({
    status: "ok",
    accessToken: "token-valido",
  });

  async signIn(email: string): Promise<SignInResult> {
    this.signInEmails.push(email);
    const result = await this.nextSignIn();
    if (result.status === "ok") {
      this.token = result.accessToken;
    }
    return result;
  }

  async getAccessToken(): Promise<string | null> {
    return this.token;
  }

  async signOut(): Promise<void> {
    this.signOutCalls += 1;
    this.token = null;
  }
}

class FakeApi implements SibiaApi {
  readonly startedSessions: string[] = [];
  readonly endedSessions: string[] = [];
  readonly messages: { accessToken: string; message: string; signal?: AbortSignal }[] = [];
  startSessionError: Error | null = null;
  reply: (message: string) => Promise<AgentReply> = async (message) => ({
    status: "ok",
    text: `Respuesta a ${message}`,
  });

  async getConfig() {
    return {
      supabaseUrl: "https://example.supabase.co",
      supabasePublishableKey: "sb_publishable_fake",
    };
  }

  async startSession(accessToken: string): Promise<void> {
    this.startedSessions.push(accessToken);
    if (this.startSessionError !== null) {
      throw this.startSessionError;
    }
  }

  async sendMessage(
    accessToken: string,
    message: string,
    signal?: AbortSignal,
  ): Promise<AgentReply> {
    this.messages.push({ accessToken, message, ...(signal === undefined ? {} : { signal }) });
    return this.reply(message);
  }

  async endSession(accessToken: string): Promise<void> {
    this.endedSessions.push(accessToken);
  }
}

function renderApp() {
  const auth = new FakeAuth();
  const api = new FakeApi();
  render(<App api={api} auth={auth} />);
  return { auth, api };
}

function submitCredentials(email = "admin@example.com", password = "clave-de-prueba") {
  fireEvent.change(screen.getByLabelText("Correo electrónico"), { target: { value: email } });
  fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "Ingresar a SIBIA" }));
}

async function renderSignedIn() {
  const context = renderApp();
  submitCredentials();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const composer = screen.getByLabelText("Escribe tu pregunta para SIBIA") as HTMLTextAreaElement;
  return { ...context, composer };
}

function ask(composer: HTMLTextAreaElement, message: string) {
  fireEvent.change(composer, { target: { value: message } });
  fireEvent.keyDown(composer, { key: "Enter" });
}

describe("acceso", () => {
  it("abre siempre con el modal de acceso y el foco en el correo", () => {
    renderApp();

    expect(screen.getByRole("dialog", { name: "Acceso seguro" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Correo electrónico"));
    expect(screen.queryByRole("button", { name: "Cerrar sesión" })).toBeNull();
  });

  it("un login correcto abre la conversación con una bienvenida estable", async () => {
    const { auth, api, composer } = await renderSignedIn();

    expect(auth.signInEmails).toEqual(["admin@example.com"]);
    expect(api.startedSessions).toEqual(["token-valido"]);
    const greeting = screen.getByRole("heading", { level: 1 }).textContent;
    expect(WELCOME_GREETINGS as readonly string[]).toContain(greeting);
    expect(document.activeElement).toBe(composer);

    fireEvent.change(composer, { target: { value: "escribiendo" } });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(greeting);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryAllByRole("article")).toHaveLength(0);
  });

  it("un login incorrecto muestra un error accesible y limpia la contraseña", async () => {
    const { auth, api } = renderApp();
    auth.nextSignIn = async () => ({ status: "invalid_credentials" });

    submitCredentials();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Correo o contraseña incorrectos.",
    );
    expect((screen.getByLabelText("Contraseña") as HTMLInputElement).value).toBe("");
    expect(api.startedSessions).toEqual([]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Ingresar a SIBIA" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("rechaza a un usuario autenticado sin acceso administrativo", async () => {
    const { auth, api } = renderApp();
    api.startSessionError = new ApiError("forbidden", "ADMIN_ACCESS_REQUIRED", "Sin acceso.");

    submitCredentials();

    expect((await screen.findByRole("alert")).textContent).toContain(
      "no tiene acceso administrativo",
    );
    expect(auth.signOutCalls).toBe(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("bloquea el botón y evita un segundo intento mientras autentica", async () => {
    const { auth } = renderApp();
    const pending = deferred<SignInResult>();
    auth.nextSignIn = () => pending.promise;

    submitCredentials();
    const button = screen.getByRole("button", { name: "Validando acceso…" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.submit(button.closest("form")!);
    expect(auth.signInEmails).toHaveLength(1);

    await act(async () => {
      pending.resolve({ status: "invalid_credentials" });
    });
    expect((screen.getByRole("button", { name: "Ingresar a SIBIA" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("muestra y oculta la contraseña", () => {
    renderApp();
    const password = screen.getByLabelText("Contraseña") as HTMLInputElement;
    const toggle = screen.getByRole("button", { name: "Mostrar contraseña" });

    expect(password.type).toBe("password");
    fireEvent.click(toggle);
    expect(password.type).toBe("text");
    expect(screen.getByRole("button", { name: "Ocultar contraseña" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("conversación", () => {
  it("envía una consulta, muestra el estado y luego la respuesta del agente", async () => {
    const { api, composer } = await renderSignedIn();
    const reply = deferred<AgentReply>();
    api.reply = () => reply.promise;
    const send = screen.getByRole("button", { name: "Enviar pregunta" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    ask(composer, "¿Qué productos tienen menos existencias?");

    expect(screen.getByRole("article", { name: "Tu mensaje" }).textContent).toBe(
      "¿Qué productos tienen menos existencias?",
    );
    expect(composer.value).toBe("");
    expect(screen.getByRole("status").textContent).toBe("SIBIA está consultando la información…");
    await waitFor(() => expect(api.messages).toHaveLength(1));
    expect(api.messages[0]?.accessToken).toBe("token-valido");
    expect(api.messages[0]?.message).toBe("¿Qué productos tienen menos existencias?");

    await act(async () => {
      reply.resolve({ status: "ok", text: "Hay **tres** productos con poco stock." });
    });

    expect(screen.queryByRole("status")).toBeNull();
    const answer = screen.getByRole("article", { name: "Respuesta de SIBIA" });
    expect(within(answer).getByText("tres").tagName).toBe("STRONG");
    await waitFor(() => expect(document.activeElement).toBe(composer));
  });

  it("Shift+Enter no envía y no se permiten envíos dobles", async () => {
    const { api, composer } = await renderSignedIn();
    const reply = deferred<AgentReply>();
    api.reply = () => reply.promise;

    fireEvent.change(composer, { target: { value: "primera" } });
    fireEvent.keyDown(composer, { key: "Enter", shiftKey: true });
    expect(screen.queryAllByRole("article")).toHaveLength(0);

    fireEvent.keyDown(composer, { key: "Enter" });
    ask(composer, "segunda");
    fireEvent.click(screen.getByRole("button", { name: "Enviar pregunta" }));
    fireEvent.submit(composer.closest("form")!);

    await act(async () => {
      reply.resolve({ status: "ok", text: "listo" });
    });
    expect(api.messages.map((entry) => entry.message)).toEqual(["primera"]);
    expect(screen.getAllByRole("article", { name: "Tu mensaje" })).toHaveLength(1);
  });

  it("un error conserva los mensajes anteriores y permite volver a preguntar", async () => {
    const { api, composer } = await renderSignedIn();
    api.reply = async () => {
      throw new ApiError("failed", "AGENT_FAILED", "detalle interno");
    };

    ask(composer, "consulta que falla");

    expect((await screen.findByRole("alert")).textContent).toContain(
      "No fue posible obtener la respuesta de SIBIA.",
    );
    expect(screen.getByRole("article", { name: "Tu mensaje" }).textContent).toBe(
      "consulta que falla",
    );

    api.reply = async () => ({ status: "ok", text: "Ahora sí." });
    ask(composer, "otra consulta");
    expect(await screen.findByText("Ahora sí.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("article", { name: "Tu mensaje" })).toHaveLength(2);
  });

  it("una respuesta 401 limpia la conversación y vuelve al modal", async () => {
    const { auth, api, composer } = await renderSignedIn();
    api.reply = async () => {
      throw new ApiError("unauthorized", "SESSION_NOT_FOUND", "fin");
    };

    ask(composer, "consulta con sesión vencida");

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert").textContent).toContain("Tu sesión terminó");
    expect(screen.queryByText("consulta con sesión vencida")).toBeNull();
    await waitFor(() => expect(auth.signOutCalls).toBe(1));
  });

  it("cerrar sesión cancela la consulta, termina la sesión web y limpia la conversación", async () => {
    const { auth, api, composer } = await renderSignedIn();
    const reply = deferred<AgentReply>();
    api.reply = () => reply.promise;
    ask(composer, "consulta pendiente");
    await waitFor(() => expect(api.messages).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Cerrar sesión" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(auth.signOutCalls).toBe(1));
    expect(api.endedSessions).toEqual(["token-valido"]);
    expect(api.messages[0]?.signal?.aborted).toBe(true);

    await act(async () => {
      reply.resolve({ status: "ok", text: "respuesta que ya no debe verse" });
    });
    expect(screen.queryByText("consulta pendiente")).toBeNull();
    expect(screen.queryByText("respuesta que ya no debe verse")).toBeNull();
  });
});
