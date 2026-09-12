import type { AppConfig } from "../config/env.js";

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
 * Tope de generación por ronda, medido con ministral-3:8b sobre 89
 * rondas reales: las llamadas a tools usaron como máximo 134 tokens y
 * las respuestas finales, incluidas tablas de diez productos, 690. La
 * salida degenerada observada llegó a 1.140 tokens. 1.024 deja margen
 * a las respuestas normales y corta una repetición sin fin; el
 * presupuesto de contexto del agente reserva ese espacio dentro de
 * num_ctx.
 */
const OLLAMA_NUM_PREDICT = 1_024;

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
/*
 * Solo se reintentan fallos transitorios del servidor. Un 4xx describe
 * una petición que Ollama volvería a rechazar.
 */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
const MAX_ERROR_DETAIL_CHARACTERS = 200;

/*
 * Límites estructurales del texto final. No miran vocabulario: una
 * respuesta normal, aunque sea una tabla de veinte productos, queda muy
 * lejos de ellos.
 */
const MAX_ASSISTANT_TEXT_CHARACTERS = 8_000;
const MIN_WORDS_FOR_DIVERSITY_CHECK = 80;
const MIN_DISTINCT_WORD_RATIO = 0.2;
const MIN_REPEATED_LINE_COUNT = 8;
const MAX_REPEATED_LINE_SHARE = 0.4;

/*
 * Marcas del formato nativo de chat de Ministral y claves del sobre de
 * tools de SIBIA. En un texto final indican que el modelo escribió
 * protocolo en lugar de una respuesta.
 */
const PROTOCOL_MARKERS =
  /\[\/?(?:INST|TOOL_CALLS|ARGS|TOOL_RESULTS|AVAILABLE_TOOLS|SYSTEM_PROMPT|CALL_ID|THINK)\]|<\/?s>|"(?:tool_calls|tool_call_id|tool_name|store_tool_result|arguments)"\s*:|\{\s*"(?:error|status|result)"\s*:|\b[a-z]+(?:_[a-z0-9]+)+\s*(?:\(\s*)?\{/u;

/*
 * Una misma unidad corta que contiene letras o dígitos repetida muchas
 * veces seguidas. Las líneas de guiones o barras de una tabla no
 * cuentan porque no tienen letras ni dígitos.
 */
const CONSECUTIVE_REPETITION = /(.{1,16}?)\1{9,}/gsu;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/*
 * Decide si un texto final del modelo puede mostrarse al usuario.
 * Devuelve el motivo del rechazo o null si el texto es aceptable.
 */
export function inspectAssistantText(text: string): string | null {
  const content = text.trim();
  if (content === "") {
    return "respuesta vacía";
  }
  if (content.length > MAX_ASSISTANT_TEXT_CHARACTERS) {
    return "longitud anormal";
  }
  if (PROTOCOL_MARKERS.test(content)) {
    return "formato de protocolo interno";
  }
  if (
    (content.startsWith("{") && content.endsWith("}")) ||
    (content.startsWith("[") && content.endsWith("]"))
  ) {
    return "estructura JSON en lugar de texto";
  }

  for (const match of content.matchAll(CONSECUTIVE_REPETITION)) {
    if (/[\p{L}\p{N}]/u.test(match[1] ?? "")) {
      return "repetición consecutiva extrema";
    }
  }

  const words = content.toLocaleLowerCase("es").match(/[\p{L}\p{N}]+/gu) ?? [];
  if (
    words.length >= MIN_WORDS_FOR_DIVERSITY_CHECK &&
    new Set(words).size / words.length < MIN_DISTINCT_WORD_RATIO
  ) {
    return "vocabulario degenerado por repetición";
  }

  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
  }
  const mostRepeated = Math.max(0, ...lineCounts.values());
  if (
    mostRepeated >= MIN_REPEATED_LINE_COUNT &&
    mostRepeated / lines.length > MAX_REPEATED_LINE_SHARE
  ) {
    return "líneas repetidas";
  }

  return null;
}

/*
 * ministral-3:8b devuelve `arguments` como objeto. Aceptamos además la
 * variante serializada porque otros builds de Ollama la usan, pero
 * siempre normalizamos a objeto: reenviar una cadena dentro del
 * historial hace que /api/chat responda HTTP 400.
 */
function normalizeToolArguments(value: unknown): Record<string, unknown> {
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
   * Ollama responde HTTP 200 con un cuerpo a cero
   * ({"model":"","message":{"role":"","content":""},"done":false})
   * mientras recarga el runner y también cuando su parser de Ministral
   * descarta una generación que no sabe interpretar. En ambos casos no
   * hay respuesta utilizable y se reintenta con más margen.
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
   * Cuando la generación se corta por límite de tokens, la respuesta o
   * la llamada a tool quedaron a medias. Eso es truncamiento, no un
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

/*
 * Resumen breve del cuerpo de un error HTTP de Ollama, solo para el
 * log de depuración.
 */
async function errorDetail(response: Response): Promise<string | null> {
  let text: string;
  try {
    text = (await response.text()).trim();
  } catch {
    return null;
  }
  if (text === "") {
    return null;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const detail =
    isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : text;
  return detail.slice(0, MAX_ERROR_DETAIL_CHARACTERS);
}

type RequestOutcome =
  | { ok: true; payload: unknown }
  | {
      ok: false;
      failure: OllamaChatError;
      retryable: boolean;
      detail: string | null;
    };

export class OllamaChatClient {
  constructor(
    private readonly config: OllamaChatConfiguration,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  /*
   * Un reintento repite únicamente esta petición a Ollama: el ciclo del
   * agente no se reinicia y ninguna tool ya ejecutada vuelve a correr.
   * Una salida dañada nunca se devuelve; tras el único reintento se
   * lanza un error con un mensaje limpio para el usuario.
   */
  async complete(
    messages: readonly OllamaChatMessage[],
    tools: readonly OllamaToolDefinition[],
  ): Promise<OllamaAssistantMessage> {
    let lastFailure: OllamaChatError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const outcome = await this.request(messages, tools);
      let failure: OllamaChatError;
      let retryable = true;
      let retryDelayMs = RETRY_DELAY_MS;

      if (!outcome.ok) {
        failure = outcome.failure;
        retryable = outcome.retryable;
        this.logRequestFailure(attempt, outcome.failure, outcome.detail);
      } else {
        const parsed = parseChatPayload(outcome.payload);
        this.log(attempt, parsed, outcome.payload);

        if (parsed.kind === "model_error") {
          throw new OllamaChatError(
            "model_error",
            "Ollama reportó un error del modelo y no pudo completar el turno.",
          );
        }

        if (parsed.kind === "message") {
          const hasToolCalls = (parsed.message.tool_calls ?? []).length > 0;
          const rejection = parsed.truncated
            ? null
            : hasToolCalls
              ? null
              : inspectAssistantText(parsed.message.content);

          if (parsed.truncated) {
            /*
             * Una generación cortada por límite de tokens no se entrega
             * ni se usa, tenga o no llamadas a tools.
             */
            failure = new OllamaChatError(
              "truncated_response",
              "Ollama cortó la respuesta por límite de tokens; no se entregó ni se guardó.",
            );
          } else if (rejection !== null) {
            this.debug({ intento: attempt, rechazo: rejection });
            failure = new OllamaChatError(
              "invalid_response",
              "El modelo generó una respuesta dañada en este turno y no se mostró. Vuelve a intentarlo.",
            );
          } else {
            return parsed.message;
          }
        } else if (parsed.kind === "unavailable") {
          failure = new OllamaChatError(
            "unavailable",
            "Ollama no entregó la respuesta del modelo en este turno. Vuelve a intentarlo.",
          );
          retryDelayMs = RELOAD_RETRY_DELAY_MS;
        } else if (parsed.kind === "empty") {
          failure = parsed.truncated
            ? new OllamaChatError(
                "truncated_response",
                "Ollama cortó la generación por límite de tokens antes de completar el turno.",
              )
            : new OllamaChatError(
                "invalid_response",
                "Ollama devolvió un turno vacío, sin texto ni llamadas a tools.",
              );
        } else {
          failure = new OllamaChatError(
            "invalid_response",
            "Ollama devolvió una respuesta con formato inválido y no se mostró.",
          );
        }
      }

      lastFailure = failure;
      if (!retryable || attempt >= MAX_ATTEMPTS) {
        break;
      }
      this.logRetry(attempt + 1, failure);
      await sleep(retryDelayMs);
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
  ): Promise<RequestOutcome> {
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
           * escribir. num_predict acota cada ronda con el margen medido
           * arriba.
           */
          options: {
            temperature: OLLAMA_TEMPERATURE,
            num_ctx: this.config.numCtx,
            num_predict: OLLAMA_NUM_PREDICT,
          },
        }),
        signal: AbortSignal.timeout(this.config.chatTimeoutMs),
      });
    } catch (error) {
      const timeout = isTimeoutError(error);
      return {
        ok: false,
        retryable: true,
        detail: null,
        failure: new OllamaChatError(
          timeout ? "timeout" : "connection_error",
          timeout
            ? "Ollama agotó el tiempo de espera para este turno."
            : "No fue posible conectar con Ollama.",
        ),
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        retryable: RETRYABLE_HTTP_STATUSES.has(response.status),
        detail: await errorDetail(response),
        failure: new OllamaChatError(
          "http_error",
          `Ollama respondió con HTTP ${response.status}.`,
        ),
      };
    }

    try {
      return { ok: true, payload: (await response.json()) as unknown };
    } catch {
      return {
        ok: false,
        retryable: false,
        detail: null,
        failure: new OllamaChatError(
          "invalid_response",
          "Ollama devolvió una respuesta que no es JSON válido.",
        ),
      };
    }
  }

  private debug(detail: Record<string, unknown>): void {
    if (this.config.debug) {
      console.error(`[sibia:ollama] ${JSON.stringify(detail)}`);
    }
  }

  private logRequestFailure(
    attempt: number,
    failure: OllamaChatError,
    detail: string | null,
  ): void {
    this.debug({
      intento: attempt,
      resultado: failure.code,
      motivo: failure.message,
      detalle: detail,
    });
  }

  private logRetry(nextAttempt: number, cause: OllamaChatError): void {
    this.debug({ reintento: nextAttempt, causa: cause.code, motivo: cause.message });
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
      detail.motivo = "Ollama devolvió un cuerpo a cero sin respuesta del modelo";
    }

    this.debug(detail);
  }
}
