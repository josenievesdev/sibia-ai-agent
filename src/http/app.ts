import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";

import {
  createWebChannel,
  type WebChannel,
} from "../channels/web/web-channel.js";
import type { AppConfig } from "../config/env.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerIntegrationCheckRoutes } from "./routes/integration-checks.js";
import { registerWebChatRoutes } from "./routes/web-chat.js";

interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  webChannel?: WebChannel | null;
}

export function buildApp(
  config: AppConfig,
  options: BuildAppOptions = {},
): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? { level: config.logLevel },
  });

  registerHealthRoute(app, config);
  registerIntegrationCheckRoutes(app, config);

  const webChannel =
    options.webChannel === undefined
      ? createWebChannel(config)
      : options.webChannel;
  registerWebChatRoutes(app, webChannel);
  if (webChannel !== null) {
    webChannel.sessions.start();
    app.addHook("onClose", async () => {
      webChannel.sessions.stop();
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const reportedStatusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
    const statusCode =
      reportedStatusCode !== undefined && reportedStatusCode >= 400
        ? reportedStatusCode
        : 500;
    const message =
      error instanceof Error ? error.message : "Solicitud HTTP inválida.";

    if (statusCode >= 500) {
      request.log.error({ error }, "Error HTTP no controlado");
    } else {
      request.log.warn({ error }, "Solicitud HTTP inválida");
    }

    return reply.code(statusCode).send({
      status: "error",
      code: statusCode >= 500 ? "INTERNAL_ERROR" : "INVALID_REQUEST",
      message:
        statusCode >= 500 ? "Ocurrió un error interno." : message,
    });
  });

  return app;
}
