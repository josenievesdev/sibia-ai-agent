import type { FastifyInstance } from "fastify";

import type { AppConfig } from "../../config/env.js";

export function registerHealthRoute(
  app: FastifyInstance,
  config: AppConfig,
): void {
  app.get("/health", async () => ({
    status: "ok" as const,
    service: "sibia-backend",
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    externalDependencies: {
      ollama: "not_checked" as const,
      supabase:
        config.supabase === null
          ? ("not_configured" as const)
          : ("not_checked" as const),
    },
  }));
}
