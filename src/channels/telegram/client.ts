export interface TelegramUser {
  id: number;
  is_bot?: boolean;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  animation?: unknown;
  audio?: unknown;
  document?: unknown;
  photo?: readonly unknown[];
  sticker?: unknown;
  video?: unknown;
  video_note?: unknown;
  voice?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramClient {
  getUpdates(
    offset: number,
    signal: AbortSignal,
    timeoutSeconds?: number,
  ): Promise<readonly TelegramUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  sendChatAction(
    chatId: number,
    action: "typing",
    signal?: AbortSignal,
  ): Promise<void>;
}

export type TelegramApiErrorCode =
  | "aborted"
  | "connection_error"
  | "http_error"
  | "invalid_response"
  | "timeout";

export class TelegramApiError extends Error {
  readonly code: TelegramApiErrorCode;
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;

  constructor(
    code: TelegramApiErrorCode,
    message: string,
    retryable = code === "connection_error" || code === "timeout",
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "TelegramApiError";
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface TelegramHttpClientOptions {
  debug?: boolean;
  fetchImplementation?: typeof fetch;
  log?: (message: string) => void;
  maxAttempts?: number;
  pollTimeoutSeconds?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const BASE_RETRY_DELAY_MS = 300;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function retryAfterMilliseconds(payload: unknown): number | null {
  if (!isRecord(payload) || !isRecord(payload.parameters)) {
    return null;
  }
  const seconds = payload.parameters.retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1_000, MAX_TIMER_DELAY_MS)
    : null;
}

function isSafeId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isTelegramUser(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeId(value.id) &&
    (value.is_bot === undefined || typeof value.is_bot === "boolean")
  );
}

function isTelegramMessage(value: unknown): boolean {
  if (!isRecord(value) || !isSafeId(value.message_id) || !isRecord(value.chat)) {
    return false;
  }
  if (!isSafeId(value.chat.id) || typeof value.chat.type !== "string") {
    return false;
  }
  if (value.from !== undefined && !isTelegramUser(value.from)) {
    return false;
  }
  return value.text === undefined || typeof value.text === "string";
}

function isTelegramUpdate(value: unknown): boolean {
  return (
    isRecord(value) &&
    isSafeId(value.update_id) &&
    value.update_id >= 0 &&
    (value.message === undefined || isTelegramMessage(value.message))
  );
}

export class TelegramHttpClient implements TelegramClient {
  private readonly debugEnabled: boolean;
  private readonly fetchImplementation: typeof fetch;
  private readonly log: (message: string) => void;
  private readonly maxAttempts: number;
  private readonly pollTimeoutSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => Promise<void>;

  constructor(
    private readonly token: string,
    options: TelegramHttpClientOptions = {},
  ) {
    this.debugEnabled = options.debug ?? false;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.log = options.log ?? ((message) => console.error(message));
    this.maxAttempts = options.maxAttempts ?? 3;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async getUpdates(
    offset: number,
    signal: AbortSignal,
    timeoutSeconds = this.pollTimeoutSeconds,
  ): Promise<readonly TelegramUpdate[]> {
    const result = await this.request(
      "getUpdates",
      {
        allowed_updates: ["message"],
        offset,
        timeout: timeoutSeconds,
      },
      signal,
      (timeoutSeconds + 5) * 1_000,
    );

    if (!Array.isArray(result)) {
      throw new TelegramApiError(
        "invalid_response",
        "Telegram devolvió una lista de updates inválida.",
      );
    }
    for (const update of result) {
      if (!isTelegramUpdate(update)) {
        throw new TelegramApiError(
          "invalid_response",
          "Telegram devolvió un update inválido.",
        );
      }
    }
    return result as unknown as TelegramUpdate[];
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.request("sendMessage", {
      chat_id: chatId,
      link_preview_options: { is_disabled: true },
      text,
    });
  }

  async sendChatAction(
    chatId: number,
    action: "typing",
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "sendChatAction",
      {
        action,
        chat_id: chatId,
      },
      signal,
    );
  }

  private async request(
    method: string,
    body: Record<string, unknown>,
    externalSignal?: AbortSignal,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    let lastFailure: TelegramApiError | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      if (isAborted(externalSignal)) {
        throw new TelegramApiError("aborted", "La solicitud a Telegram se detuvo.");
      }

      let response: Response;
      try {
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal =
          externalSignal === undefined
            ? timeoutSignal
            : AbortSignal.any([externalSignal, timeoutSignal]);
        response = await this.fetchImplementation(
          `https://api.telegram.org/bot${this.token}/${method}`,
          {
            body: JSON.stringify(body),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            method: "POST",
            signal,
          },
        );
      } catch (error) {
        if (isAborted(externalSignal)) {
          throw new TelegramApiError("aborted", "La solicitud a Telegram se detuvo.");
        }
        const timeout = isTimeoutError(error);
        const retryable = method !== "sendMessage";
        lastFailure = new TelegramApiError(
          timeout ? "timeout" : "connection_error",
          timeout
            ? "Telegram agotó el tiempo de espera."
            : "No fue posible conectar con Telegram.",
          retryable,
        );
        this.debug(method, attempt, lastFailure.code, null);
        if (retryable && attempt < this.maxAttempts) {
          await this.sleep(this.backoff(attempt), externalSignal);
          continue;
        }
        throw lastFailure;
      }

      let payload: unknown = null;
      let payloadError: unknown = null;
      try {
        payload = (await response.json()) as unknown;
      } catch (error) {
        payloadError = error;
      }
      if (isAborted(externalSignal)) {
        throw new TelegramApiError("aborted", "La solicitud a Telegram se detuvo.");
      }

      if (!response.ok) {
        const retryable = RETRYABLE_HTTP_STATUSES.has(response.status);
        const retryAfterMs = retryAfterMilliseconds(payload);
        lastFailure = new TelegramApiError(
          "http_error",
          `Telegram respondió con HTTP ${response.status}.`,
          retryable,
          retryAfterMs,
        );
        this.debug(method, attempt, lastFailure.code, response.status);
        if (retryable && attempt < this.maxAttempts) {
          await this.sleep(
            retryAfterMs ?? this.backoff(attempt),
            externalSignal,
          );
          continue;
        }
        throw lastFailure;
      }

      if (payloadError !== null) {
        const timeout = isTimeoutError(payloadError);
        const malformedJson = payloadError instanceof SyntaxError;
        const retryable =
          method !== "sendMessage" && (timeout || !malformedJson);
        lastFailure = new TelegramApiError(
          timeout
            ? "timeout"
            : malformedJson
              ? "invalid_response"
              : "connection_error",
          timeout
            ? "Telegram agotó el tiempo de espera al entregar su respuesta."
            : malformedJson
              ? "Telegram devolvió una respuesta que no es JSON válido."
              : "La conexión con Telegram se interrumpió durante la respuesta.",
          retryable,
        );
        this.debug(method, attempt, lastFailure.code, response.status);
        if (retryable && attempt < this.maxAttempts) {
          await this.sleep(this.backoff(attempt), externalSignal);
          continue;
        }
        throw lastFailure;
      }

      if (!isRecord(payload) || payload.ok !== true || !("result" in payload)) {
        const apiStatus =
          isRecord(payload) && typeof payload.error_code === "number"
            ? payload.error_code
            : null;
        const retryable =
          apiStatus !== null && RETRYABLE_HTTP_STATUSES.has(apiStatus);
        const retryAfterMs = retryAfterMilliseconds(payload);
        lastFailure = new TelegramApiError(
          apiStatus === null ? "invalid_response" : "http_error",
          apiStatus === null
            ? "Telegram devolvió una respuesta inválida."
            : `Telegram rechazó la solicitud con código ${apiStatus}.`,
          retryable,
          retryAfterMs,
        );
        this.debug(method, attempt, lastFailure.code, apiStatus);
        if (retryable && attempt < this.maxAttempts) {
          await this.sleep(
            retryAfterMs ?? this.backoff(attempt),
            externalSignal,
          );
          continue;
        }
        throw lastFailure;
      }

      return payload.result;
    }

    throw (
      lastFailure ??
      new TelegramApiError(
        "connection_error",
        "No fue posible completar la solicitud a Telegram.",
      )
    );
  }

  private backoff(attempt: number): number {
    return Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 2_400);
  }

  private debug(
    method: string,
    attempt: number,
    result: TelegramApiErrorCode,
    httpStatus: number | null,
  ): void {
    if (!this.debugEnabled) {
      return;
    }
    this.log(
      `[sibia:telegram] ${JSON.stringify({
        metodo: method,
        intento: attempt,
        resultado: result,
        estadoHttp: httpStatus,
      })}`,
    );
  }
}
