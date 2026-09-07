import type { FastifyInstance, FastifyReply } from "fastify";

import type { AppConfig } from "../../config/env.js";
import type { IntegrationCheckResult } from "../../integrations/check-result.js";
import { checkOllamaModel } from "../../integrations/ollama/client.js";
import { checkSupabaseSchema } from "../../integrations/supabase/check.js";

function sendCheckResult(
  reply: FastifyReply,
  result: IntegrationCheckResult,
): FastifyReply {
  const statusCode =
    result.status === "available"
      ? 200
      : result.status === "authentication_failed"
        ? 401
        : result.status === "permission_denied"
          ? 403
          : 503;
  return reply.code(statusCode).send(result);
}

export function registerIntegrationCheckRoutes(
  app: FastifyInstance,
  config: AppConfig,
): void {
  app.get("/checks/ollama", async (_request, reply) => {
    return sendCheckResult(reply, await checkOllamaModel(config));
  });

  app.get("/checks/supabase", async (_request, reply) => {
    return sendCheckResult(reply, await checkSupabaseSchema(config));
  });
}
