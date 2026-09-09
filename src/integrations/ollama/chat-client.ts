import type { AppConfig } from "../../config/env.js";

export type OllamaChatRole = "assistant" | "system" | "tool" | "user";

export interface OllamaToolCall {
  id?: string;
  type: "function";
  function: {
    index?: number;
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaChatMessage {
  role: OllamaChatRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface OllamaAssistantMessage extends OllamaChatMessage {
  role: "assistant";
}

export interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type OllamaChatErrorCode =
  | "connection_error"
  | "http_error"
  | "invalid_response"
  | "model_error"
  | "timeout"
  | "truncated_response"
  | "unavailable";

export class OllamaChatError extends Error {
  readonly code: OllamaChatErrorCode;

  constructor(code: OllamaChatErrorCode, message: string) {
    super(message);
    this.name = "OllamaChatError";
    this.code = code;
  }
}

type OllamaChatConfiguration = Pick<
  AppConfig["ollama"],
  "baseUrl" | "chatTimeoutMs" | "debug" | "model" | "numCtx"
>;

/*
 * Una única temperatura conservadora para todo el agente. Sirve tanto
 * para elegir tools como para redactar la respuesta final; la
 * naturalidad viene del prompt y de dejar escribir al modelo, no de
 * subir este valor.
 */
const OLLAMA_TEMPERATURE = 0.2;

/*
 * Como máximo un reintento por llamada.
 */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 400;
/*
 * Recargar el runner de Ollama tarda bastante más que un reintento
 * normal, así que ese caso espera más antes del único reintento.
 */
const RELOAD_RETRY_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/*
 * ministral-3:8b devuelve `arguments` como objeto. Aceptamos además la
 * variante serializada porque otros builds de Ollama la usan, pero
 * siempre normalizamos a objeto: reenviar una cadena dentro del
 * historial hace que /api/chat responda HTTP 400.
 */
export function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export interface ParsedToolCalls {
  calls: OllamaToolCall[];
  malformed: number;
}

/*
 * Una entrada malformada no invalida el resto de la respuesta: se
 * descarta y se contabiliza. Solo devolvemos null cuando `tool_calls`
 * ni siquiera es una lista.
 */
export function parseToolCalls(value: unknown): ParsedToolCalls | null {
  if (value === undefined || value === null) {
    return { calls: [], malformed: 0 };
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const calls: OllamaToolCall[] = [];
  const seen = new Set<string>();
  let malformed = 0;

  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.function)) {
      malformed += 1;
      continue;
    }

    const name = entry.function.name;
    if (typeof name !== "string" || name.trim() === "") {
      malformed += 1;
      continue;
    }

    const parsedFunction: OllamaToolCall["function"] = {
      name: name.trim(),
      arguments: normalizeToolArguments(entry.function.arguments),
    };
    const index = entry.function.index;
    if (typeof index === "number" && Number.isInteger(index) && index >= 0) {
      parsedFunction.index = index;
    }

    const key = `${parsedFunction.name}:${JSON.stringify(parsedFunction.arguments)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const parsedCall: OllamaToolCall = {
      type: "function",
      function: parsedFunction,
    };
    if (typeof entry.id === "string" && entry.id.trim() !== "") {
      parsedCall.id = entry.id;
    }
    calls.push(parsedCall);
  }

  return { calls, malformed };
}

export type ParsedChatPayload =
  | { kind: "message"; message: OllamaAssistantMessage; truncated: boolean }
  | { kind: "empty"; truncated: boolean }
  | { kind: "invalid"; reason: string }
  | { kind: "model_error"; reason: string }
  | { kind: "unavailable" };

/*
 * Ollama puede responder HTTP 200 con `content`, con `tool_calls` o con
 * ambos. Ninguno de los dos campos es obligatorio, así que no se
 * rechaza una respuesta válida por la ausencia de uno de ellos.
 */
export function parseChatPayload(payload: unknown): ParsedChatPayload {
  if (!isRecord(payload)) {
    return { kind: "invalid", reason: "el cuerpo no es un objeto JSON" };
  }
  if (typeof payload.error === "string" && payload.error.trim() !== "") {
    return { kind: "model_error", reason: payload.error.trim() };
  }
  if (!isRecord(payload.message)) {
    return { kind: "invalid", reason: "falta el campo message" };
  }

  /*
   * Mientras Ollama carga o recarga el runner del modelo responde HTTP
   * 200 con un cuerpo a cero: {"model":"","message":{"role":"",
   * "content":""},"done":false}. Es una condición transitoria, no un
   * formato inválido, así que se reintenta con más margen.
   */
  if (payload.done !== true && payload.model === "") {
    return { kind: "unavailable" };
  }

  const rawMessage = payload.message;
  if (rawMessage.role !== "assistant") {
    return {
      kind: "invalid",
      reason: `message.role inesperado: ${JSON.stringify(rawMessage.role)}`,
    };
  }

  const rawContent = rawMessage.content;
  if (rawContent !== undefined && typeof rawContent !== "string") {
    return { kind: "invalid", reason: "message.content no es texto" };
  }
  const content = rawContent ?? "";

  const parsed = parseToolCalls(rawMessage.tool_calls);
  if (parsed === null) {
    return { kind: "invalid", reason: "message.tool_calls no es una lista" };
  }

  /*
   * Cuando la generación se corta por límite de tokens mientras el
   * modelo escribe una llamada a tool, Ollama no consigue cerrarla y
   * devuelve `content: ""` sin `tool_calls`. Eso es truncamiento, no un
   * formato inválido, y se trata como tal.
   */
  const truncated = payload.done_reason === "length";

  if (content.trim() === "" && parsed.calls.length === 0) {
    return { kind: "empty", truncated };
  }

  const message: OllamaAssistantMessage = { role: "assistant", content };
  if (parsed.calls.length > 0) {
    message.tool_calls = parsed.calls;
  }
  return { kind: "message", message, truncated };
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export class OllamaChatClient {
  constructor(
    private readonly config: OllamaChatConfiguration,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async complete(
    messages: readonly OllamaChatMessage[],
    tools: readonly OllamaToolDefinition[],
  ): Promise<OllamaAssistantMessage> {
    let lastFailure: OllamaChatError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const payload = await this.request(messages, tools);
      const parsed = parseChatPayload(payload);
      this.log(attempt, parsed, payload);

      if (parsed.kind === "model_error") {
        throw new OllamaChatError(
          "model_error",
          `Ollama reportó un error del modelo: ${parsed.reason}`,
        );
      }

      if (parsed.kind === "message") {
        /*
         * Una respuesta final cortada a mitad de frase no se entrega ni
         * se guarda. Si el modelo pidió tools, la llamada llegó
         * completa y el texto que la acompaña no se usa.
         */
        const hasToolCalls = (parsed.message.tool_calls ?? []).length > 0;
        if (!parsed.truncated || hasToolCalls) {
          return parsed.message;
        }
        lastFailure = new OllamaChatError(
          "truncated_response",
          "Ollama cortó la respuesta por límite de tokens; no se entregó ni se guardó.",
        );
      } else if (parsed.kind === "unavailable") {
        lastFailure = new OllamaChatError(
          "unavailable",
          "Ollama no completó el turno porque estaba cargando el modelo. Vuelve a intentarlo.",
        );
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RELOAD_RETRY_DELAY_MS);
          continue;
        }
      } else if (parsed.kind === "empty") {
        lastFailure = parsed.truncated
          ? new OllamaChatError(
              "truncated_response",
              "Ollama cortó la generación por límite de tokens antes de completar el turno.",
            )
          : new OllamaChatError(
              "invalid_response",
              "Ollama devolvió un turno vacío, sin texto ni llamadas a tools.",
            );
      } else {
        lastFailure = new OllamaChatError(
          "invalid_response",
          `Ollama devolvió una respuesta de chat con formato inválido: ${parsed.reason}.`,
        );
      }

      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }

    throw (
      lastFailure ??
      new OllamaChatError(
        "invalid_response",
        "No fue posible obtener una respuesta válida de Ollama.",
      )
    );
  }

  private async request(
    messages: readonly OllamaChatMessage[],
    tools: readonly OllamaToolDefinition[],
  ): Promise<unknown> {
    const chatUrl = new URL("api/chat", `${this.config.baseUrl}/`);
    let response: Response;

    try {
      response = await this.fetchImplementation(chatUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          messages,
          tools,
          stream: false,
          think: false,
          /*
           * num_ctx se declara explícitamente: con el valor por defecto
           * de Ollama (4096) el prompt de SIBIA más las definiciones de
           * tools y un resultado de tool no caben, y Ollama recorta el
           * prompt en silencio o corta la llamada a tool a medio
           * escribir. Tampoco se fija num_predict, para no truncar ni
           * la llamada a tool ni la respuesta final.
           */
          options: {
            temperature: OLLAMA_TEMPERATURE,
            num_ctx: this.config.numCtx,
          },
        }),
        signal: AbortSignal.timeout(this.config.chatTimeoutMs),
      });
    } catch (error) {
      throw new OllamaChatError(
        isTimeoutError(error) ? "timeout" : "connection_error",
        isTimeoutError(error)
          ? "Ollama agotó el tiempo de espera para este turno."
          : "No fue posible conectar con Ollama.",
      );
    }

    if (!response.ok) {
      throw new OllamaChatError(
        "http_error",
        `Ollama respondió con HTTP ${response.status}.`,
      );
    }

    try {
      return (await response.json()) as unknown;
    } catch {
      throw new OllamaChatError(
        "invalid_response",
        "Ollama devolvió una respuesta que no es JSON válido.",
      );
    }
  }

  private log(
    attempt: number,
    parsed: ParsedChatPayload,
    payload: unknown,
  ): void {
    if (!this.config.debug) {
      return;
    }

    const raw = isRecord(payload) ? payload : {};
    const detail: Record<string, unknown> = {
      intento: attempt,
      resultado: parsed.kind,
      done_reason: raw.done_reason ?? null,
      prompt_eval_count: raw.prompt_eval_count ?? null,
      eval_count: raw.eval_count ?? null,
    };
    if (parsed.kind === "message") {
      detail.truncada = parsed.truncated;
      detail.longitudContenido = parsed.message.content.length;
      detail.toolCalls = (parsed.message.tool_calls ?? []).map((call) => ({
        name: call.function.name,
        arguments: call.function.arguments,
      }));
    }
    if (parsed.kind === "empty") {
      detail.truncada = parsed.truncated;
    }
    if (parsed.kind === "invalid" || parsed.kind === "model_error") {
      detail.motivo = parsed.reason;
    }
    if (parsed.kind === "unavailable") {
      detail.motivo = "Ollama devolvió un turno incompleto mientras cargaba el modelo";
    }

    console.error(`[sibia:ollama] ${JSON.stringify(detail)}`);
  }
}
