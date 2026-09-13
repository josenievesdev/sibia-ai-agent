import type { SupabaseClient } from "@supabase/supabase-js";

import { OllamaChatClient } from "../../ai/ollama-client.js";
import {
  StoreChatAgent,
  type ChatCompletionClient,
  type ChatTurnStatus,
} from "../../ai/sibia-agent.js";
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

/*
 * El canal web no interpreta preguntas ni redacta respuestas: entrega el
 * texto al StoreChatAgent existente y devuelve lo que este respondió.
 */
export interface WebConversationAgent {
  respond(message: string): Promise<{ status: ChatTurnStatus; text: string }>;
}

export type WebConversationCreation =
  | { status: "ready"; agent: WebConversationAgent }
  | { status: "forbidden" }
  | { status: "unavailable" };

export interface WebAgentFactory {
  /*
   * accessToken devuelve siempre el JWT más reciente del usuario, porque
   * el navegador lo renueva mientras la conversación sigue abierta.
   */
  createConversation(accessToken: () => string): Promise<WebConversationCreation>;
}

export interface SibiaWebAgentFactoryConfig {
  businessName: string;
  integrationCheckTimeoutMs: number;
  ollama: AppConfig["ollama"];
  supabase: SupabaseConfig;
}

export interface SibiaWebAgentFactoryDependencies {
  checkAccess?: (
    client: SupabaseClient,
    timeoutMs: number,
  ) => Promise<AdminAccessResult>;
  createConnection?: (
    config: SupabaseConfig,
    options?: SupabaseConnectionOptions,
  ) => SupabaseClient;
  model?: ChatCompletionClient;
}

export class SibiaWebAgentFactory implements WebAgentFactory {
  private readonly checkAccess: (
    client: SupabaseClient,
    timeoutMs: number,
  ) => Promise<AdminAccessResult>;
  private readonly createConnection: (
    config: SupabaseConfig,
    options?: SupabaseConnectionOptions,
  ) => SupabaseClient;
  private readonly model: ChatCompletionClient;

  constructor(
    private readonly config: SibiaWebAgentFactoryConfig,
    dependencies: SibiaWebAgentFactoryDependencies = {},
  ) {
    this.checkAccess = dependencies.checkAccess ?? checkActiveAdminAccess;
    this.createConnection =
      dependencies.createConnection ?? createSupabaseConnection;
    this.model = dependencies.model ?? new OllamaChatClient(config.ollama);
  }

  async createConversation(
    accessToken: () => string,
  ): Promise<WebConversationCreation> {
    let client: SupabaseClient;
    try {
      /*
       * Un cliente por conversación con el JWT del usuario: las tools
       * consultan Supabase con esa identidad y RLS decide qué ve.
       */
      client = this.createConnection(this.config.supabase, {
        accessToken: async () => accessToken(),
        requestTimeoutMs: this.config.integrationCheckTimeoutMs,
      });
    } catch {
      return { status: "unavailable" };
    }

    const access = await this.checkAccess(
      client,
      this.config.integrationCheckTimeoutMs,
    );
    if (access.status === "forbidden") {
      return { status: "forbidden" };
    }
    if (access.status !== "authorized") {
      return { status: "unavailable" };
    }

    const catalog = new StoreReadToolCatalog(
      new StoreReadTools(new SupabaseStoreGateway(client)),
    );
    return {
      status: "ready",
      agent: new StoreChatAgent(this.model, catalog, {
        businessName: this.config.businessName,
      }),
    };
  }
}
