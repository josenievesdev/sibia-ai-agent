import type { SupabaseClient } from "@supabase/supabase-js";

import {
  StoreChatAgent,
  type ChatCompletionClient,
} from "../../ai/sibia-agent.js";
import { OllamaChatClient } from "../../ai/ollama-client.js";
import type { AppConfig, SupabaseConfig } from "../../config/env.js";
import {
  checkActiveAdminAccess,
  type AdminAccessResult,
} from "../../integrations/supabase/admin-access.js";
import {
  createSupabaseConnection,
  type SupabaseConnectionOptions,
} from "../../integrations/supabase/client.js";
import { SupabaseStoreGateway } from "../../store/supabase-store-gateway.js";
import { StoreReadToolCatalog } from "../../tools/store-read-tool-catalog.js";
import { StoreReadTools } from "../../tools/store-read-tools.js";
import type {
  TelegramAgentFactory,
  TelegramConversationAgent,
} from "./bot.js";

export interface TelegramSibiaAgentFactoryConfig {
  businessName: string;
  integrationCheckTimeoutMs: number;
  ollama: AppConfig["ollama"];
  supabase: SupabaseConfig;
  supabaseEmail: string;
  supabasePassword: string;
}

export type TelegramAgentFactoryErrorCode =
  | "authentication_failed"
  | "closed"
  | "connection_error"
  | "forbidden"
  | "not_available";

export class TelegramAgentFactoryError extends Error {
  readonly code: TelegramAgentFactoryErrorCode;

  constructor(code: TelegramAgentFactoryErrorCode, message: string) {
    super(message);
    this.name = "TelegramAgentFactoryError";
    this.code = code;
  }
}

export interface TelegramSibiaAgentFactoryDependencies {
  checkAccess?: (
    client: SupabaseClient,
    timeoutMs: number,
  ) => Promise<AdminAccessResult>;
  createConnection?: (
    config: SupabaseConfig,
    options?: SupabaseConnectionOptions,
  ) => SupabaseClient;
  model?: ChatCompletionClient;
  now?: () => number;
  retryCooldownMs?: number;
}

const DEFAULT_RETRY_COOLDOWN_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConnectionAuthError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  const status = error.status;
  return (
    error.name === "AuthRetryableFetchError" ||
    status === 0 ||
    (typeof status === "number" && status >= 500)
  );
}

async function disposeClientQuietly(
  client: SupabaseClient,
  signOut: boolean,
): Promise<void> {
  if (signOut) {
    try {
      await client.auth.signOut({ scope: "local" });
    } catch {
      // El cierre continúa aunque Supabase no esté disponible.
    }
  }
  try {
    await client.auth.dispose();
  } catch {
    // dispose es local y defensivo; un fallo tampoco bloquea el apagado.
  }
}

export class TelegramSibiaAgentFactory implements TelegramAgentFactory {
  private readonly checkAccess: (
    client: SupabaseClient,
    timeoutMs: number,
  ) => Promise<AdminAccessResult>;
  private readonly createConnection: (
    config: SupabaseConfig,
    options?: SupabaseConnectionOptions,
  ) => SupabaseClient;
  private readonly model: ChatCompletionClient;
  private readonly now: () => number;
  private readonly retryCooldownMs: number;
  private catalog: StoreReadToolCatalog | null = null;
  private client: SupabaseClient | null = null;
  private failure: TelegramAgentFactoryError | null = null;
  private initialization: Promise<void> | null = null;
  private retryAllowedAt = 0;
  private closed = false;

  constructor(
    private readonly config: TelegramSibiaAgentFactoryConfig,
    dependencies: TelegramSibiaAgentFactoryDependencies = {},
  ) {
    this.checkAccess = dependencies.checkAccess ?? checkActiveAdminAccess;
    this.createConnection =
      dependencies.createConnection ?? createSupabaseConnection;
    this.model = dependencies.model ?? new OllamaChatClient(config.ollama);
    this.now = dependencies.now ?? Date.now;
    this.retryCooldownMs =
      dependencies.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
  }

  async initialize(): Promise<void> {
    if (this.closed) {
      throw new TelegramAgentFactoryError(
        "closed",
        "La sesión de Telegram ya está cerrada.",
      );
    }
    if (this.catalog !== null) {
      return;
    }
    if (this.failure !== null) {
      const terminal =
        this.failure.code === "authentication_failed" ||
        this.failure.code === "forbidden" ||
        this.failure.code === "not_available";
      if (terminal || this.now() < this.retryAllowedAt) {
        throw this.failure;
      }
      this.failure = null;
    }
    if (this.initialization === null) {
      const pending = this.connect().catch((error: unknown) => {
        const failure =
          error instanceof TelegramAgentFactoryError
            ? error
            : new TelegramAgentFactoryError(
                "connection_error",
                "No fue posible iniciar la sesión dedicada de Telegram.",
              );
        this.failure = failure;
        this.retryAllowedAt = this.now() + this.retryCooldownMs;
        throw failure;
      });
      this.initialization = pending;
      void pending.then(
        () => this.clearInitialization(pending),
        () => this.clearInitialization(pending),
      );
    }
    await this.initialization;
  }

  async createAgent(): Promise<TelegramConversationAgent> {
    await this.initialize();
    if (this.catalog === null) {
      throw new TelegramAgentFactoryError(
        "not_available",
        "Los datos de SIBIA no están disponibles.",
      );
    }
    return new StoreChatAgent(this.model, this.catalog, {
      businessName: this.config.businessName,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.initialization !== null) {
      await this.initialization.catch(() => undefined);
    }

    const client = this.client;
    this.client = null;
    this.catalog = null;
    this.failure = null;
    if (client !== null) {
      await disposeClientQuietly(client, true);
    }
  }

  private async connect(): Promise<void> {
    let client: SupabaseClient;
    try {
      client = this.createConnection(this.config.supabase, {
        autoRefreshToken: true,
        requestTimeoutMs: this.config.integrationCheckTimeoutMs,
      });
    } catch {
      throw new TelegramAgentFactoryError(
        "connection_error",
        "No fue posible preparar la conexión con Supabase.",
      );
    }

    let authenticated = false;
    try {
      let authenticationError: unknown;
      try {
        const result = await client.auth.signInWithPassword({
          email: this.config.supabaseEmail,
          password: this.config.supabasePassword,
        });
        authenticationError = result.error;
      } catch {
        throw new TelegramAgentFactoryError(
          "connection_error",
          "No fue posible conectar con Supabase Auth.",
        );
      }

      if (authenticationError !== null) {
        const connectionFailure = isConnectionAuthError(authenticationError);
        throw new TelegramAgentFactoryError(
          connectionFailure ? "connection_error" : "authentication_failed",
          connectionFailure
            ? "No fue posible conectar con Supabase Auth."
            : "Supabase Auth rechazó la cuenta dedicada de Telegram.",
        );
      }
      authenticated = true;

      const access = await this.checkAccess(
        client,
        this.config.integrationCheckTimeoutMs,
      );
      if (access.status !== "authorized") {
        const code =
          access.status === "forbidden"
            ? "forbidden"
            : access.status === "not_available"
              ? "not_available"
              : "connection_error";
        throw new TelegramAgentFactoryError(
          code,
          access.status === "forbidden"
            ? "La cuenta dedicada de Telegram no tiene acceso administrativo activo."
            : "No fue posible comprobar el acceso de la cuenta dedicada de Telegram.",
        );
      }
      if (this.closed) {
        throw new TelegramAgentFactoryError(
          "closed",
          "La sesión de Telegram se cerró durante la autenticación.",
        );
      }

      this.client = client;
      this.catalog = new StoreReadToolCatalog(
        new StoreReadTools(new SupabaseStoreGateway(client)),
      );
    } catch (error) {
      await disposeClientQuietly(client, authenticated);
      if (error instanceof TelegramAgentFactoryError) {
        throw error;
      }
      throw new TelegramAgentFactoryError(
        "connection_error",
        "No fue posible iniciar la sesión dedicada de Telegram.",
      );
    }
  }

  private clearInitialization(pending: Promise<void>): void {
    if (this.initialization === pending) {
      this.initialization = null;
    }
  }
}
