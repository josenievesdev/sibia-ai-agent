import type { AppConfig } from "../config/env.js";
import type { IntegrationCheckResult } from "./check-result.js";

interface OllamaModel {
  name?: unknown;
  model?: unknown;
}

function getModelNames(payload: unknown): string[] | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("models" in payload) ||
    !Array.isArray(payload.models)
  ) {
    return null;
  }

  const names: string[] = [];

  for (const entry of payload.models) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }

    const model = entry as OllamaModel;
    if (typeof model.name === "string") {
      names.push(model.name);
      continue;
    }

    if (typeof model.model === "string") {
      names.push(model.model);
      continue;
    }

    return null;
  }

  return names;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "La comprobación de Ollama agotó el tiempo de espera.";
  }

  return "No fue posible conectar con Ollama.";
}

export async function checkOllamaModel(
  config: AppConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<IntegrationCheckResult> {
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();

  try {
    const tagsUrl = new URL("api/tags", `${config.ollama.baseUrl}/`);
    const response = await fetchImplementation(tagsUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(config.integrationCheckTimeoutMs),
    });

    if (!response.ok) {
      return {
        integration: "ollama",
        status: "unavailable",
        code: "OLLAMA_HTTP_ERROR",
        message: `Ollama respondió con HTTP ${response.status}.`,
        checkedAt,
        durationMs: Math.round(performance.now() - startedAt),
        metadata: { model: config.ollama.model },
      };
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return {
        integration: "ollama",
        status: "unavailable",
        code: "OLLAMA_INVALID_RESPONSE",
        message: "Ollama respondió, pero /api/tags no devolvió JSON válido.",
        checkedAt,
        durationMs: Math.round(performance.now() - startedAt),
        metadata: { model: config.ollama.model },
      };
    }

    const modelNames = getModelNames(payload);
    if (modelNames === null) {
      return {
        integration: "ollama",
        status: "unavailable",
        code: "OLLAMA_INVALID_RESPONSE",
        message: "Ollama respondió, pero el formato de /api/tags no es válido.",
        checkedAt,
        durationMs: Math.round(performance.now() - startedAt),
        metadata: { model: config.ollama.model },
      };
    }

    if (!modelNames.includes(config.ollama.model)) {
      return {
        integration: "ollama",
        status: "unavailable",
        code: "OLLAMA_MODEL_NOT_FOUND",
        message: `Ollama está disponible, pero no ofrece el modelo ${config.ollama.model}.`,
        checkedAt,
        durationMs: Math.round(performance.now() - startedAt),
        metadata: {
          model: config.ollama.model,
          installedModelCount: modelNames.length,
        },
      };
    }

    return {
      integration: "ollama",
      status: "available",
      code: "OLLAMA_MODEL_AVAILABLE",
      message: `Ollama y el modelo ${config.ollama.model} están disponibles.`,
      checkedAt,
      durationMs: Math.round(performance.now() - startedAt),
      metadata: {
        model: config.ollama.model,
        installedModelCount: modelNames.length,
      },
    };
  } catch (error) {
    return {
      integration: "ollama",
      status: "unavailable",
      code: "OLLAMA_CONNECTION_FAILED",
      message: errorMessage(error),
      checkedAt,
      durationMs: Math.round(performance.now() - startedAt),
      metadata: { model: config.ollama.model },
    };
  }
}
