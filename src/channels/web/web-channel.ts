import type { AppConfig, SupabaseConfig } from "../../config/env.js";
import { SupabaseWebTokenVerifier, type WebTokenVerifier } from "./web-auth.js";
import { SibiaWebAgentFactory } from "./web-agent-factory.js";
import { WebSessionManager } from "./web-session-manager.js";

export interface WebChannel {
  supabase: SupabaseConfig;
  verifier: WebTokenVerifier;
  sessions: WebSessionManager;
}

/*
 * Compone el canal web con el mismo agente, tools y gateway que la consola
 * y Telegram. Sin Supabase configurado el canal no existe y sus rutas
 * responden que no está disponible.
 */
export function createWebChannel(config: AppConfig): WebChannel | null {
  if (config.supabase === null) {
    return null;
  }
  return {
    supabase: config.supabase,
    verifier: new SupabaseWebTokenVerifier(
      config.supabase,
      config.integrationCheckTimeoutMs,
    ),
    sessions: new WebSessionManager(
      new SibiaWebAgentFactory({
        businessName: config.businessName,
        integrationCheckTimeoutMs: config.integrationCheckTimeoutMs,
        ollama: config.ollama,
        supabase: config.supabase,
      }),
    ),
  };
}
