import type { AppConfig } from "../../config/env.js";

export type OllamaChatRole = "assistant" | "system" | "tool" | "user";

export interface OllamaToolCall {
  id?: string;
  type: "function";
  function: {
    index?: number;
    name: string;
    arguments: unknown;
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
  | "timeout";

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
  "baseUrl" | "chatTimeoutMs" | "model"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseToolCalls(value: unknown): OllamaToolCall[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const calls: OllamaToolCall[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isRecord(entry.function)) {
      return null;
    }

    const name = entry.function.name;
    if (typeof name !== "string" || name.trim() === "") {
      return null;
    }

    const parsedFunction: OllamaToolCall["function"] = {
      name: name.trim(),
      arguments:
        "arguments" in entry.function ? entry.function.arguments : {},
    };
    if (
      typeof entry.function.index === "number" &&
      Number.isInteger(entry.function.index) &&
      entry.function.index >= 0
    ) {
      parsedFunction.index = entry.function.index;
    }

    const parsedCall: OllamaToolCall = {
      type: "function",
      function: parsedFunction,
    };
    if (typeof entry.id === "string" && entry.id.trim() !== "") {
      parsedCall.id = entry.id;
    }
    calls.push(parsedCall);
  }

  return calls;
}

function parseAssistantMessage(payload: unknown): OllamaAssistantMessage | null {
  if (!isRecord(payload) || !isRecord(payload.message)) {
    return null;
  }

  const rawMessage = payload.message;
  if (rawMessage.role !== "assistant") {
    return null;
  }

  const content =
    rawMessage.content === undefined ? "" : rawMessage.content;
  if (typeof content !== "string") {
    return null;
  }

  const toolCalls = parseToolCalls(rawMessage.tool_calls);
  if (toolCalls === null || (content.trim() === "" && toolCalls.length === 0)) {
    return null;
  }

  const message: OllamaAssistantMessage = {
    role: "assistant",
    content,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return message;
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
          options: {
            temperature: 0.1,
            num_predict: 500,
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

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new OllamaChatError(
        "invalid_response",
        "Ollama devolvió una respuesta que no es JSON válido.",
      );
    }

    const message = parseAssistantMessage(payload);
    if (message === null) {
      throw new OllamaChatError(
        "invalid_response",
        "Ollama devolvió una respuesta de chat con formato inválido.",
      );
    }

    return message;
  }
}
