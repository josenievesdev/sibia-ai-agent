import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import {
  readBearerToken,
  type WebIdentity,
} from "../../channels/web/web-auth.js";
import type { WebChannel } from "../../channels/web/web-channel.js";

const MAX_MESSAGE_CHARACTERS = 4_000;

interface ChatBody {
  message: string;
}

function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
): FastifyReply {
  return reply.code(statusCode).send({ status: "error", code, message });
}

/*
 * Cada solicitud del canal web se autentica por separado: el token nunca
 * se da por válido por haber sido aceptado antes.
 */
async function authenticate(
  channel: WebChannel,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ identity: WebIdentity; accessToken: string } | null> {
  const accessToken = readBearerToken(request.headers.authorization);
  if (accessToken === null) {
    sendError(reply, 401, "AUTH_REQUIRED", "Inicia sesión para usar SIBIA.");
    return null;
  }

  const verification = await channel.verifier.verify(accessToken);
  if (verification.status === "unavailable") {
    sendError(
      reply,
      503,
      "AUTH_UNAVAILABLE",
      "No fue posible validar la sesión en este momento.",
    );
    return null;
  }
  if (verification.status === "invalid") {
    sendError(
      reply,
      401,
      "INVALID_TOKEN",
      "La sesión no es válida o ya venció.",
    );
    return null;
  }
  return { identity: verification.identity, accessToken };
}

export function registerWebChatRoutes(
  app: FastifyInstance,
  channel: WebChannel | null,
): void {
  app.register(
    async (web) => {
      web.addHook("onRequest", async (_request, reply) => {
        reply.header("cache-control", "no-store");
        if (channel === null) {
          return sendError(
            reply,
            503,
            "WEB_NOT_CONFIGURED",
            "El canal web necesita SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY.",
          );
        }
      });

      /*
       * Solo la URL y la publishable key, que son públicas por diseño.
       */
      web.get("/config", async () => ({
        status: "ok" as const,
        supabase: {
          url: channel!.supabase.url,
          publishableKey: channel!.supabase.publishableKey,
        },
      }));

      web.post("/session", async (request, reply) => {
        const auth = await authenticate(channel!, request, reply);
        if (auth === null) {
          return reply;
        }

        const result = await channel!.sessions.open(
          auth.identity,
          auth.accessToken,
        );
        switch (result) {
          case "ready":
            return { status: "ok" as const };
          case "forbidden":
            return sendError(
              reply,
              403,
              "ADMIN_ACCESS_REQUIRED",
              "Tu cuenta no tiene acceso administrativo activo en SIBIA.",
            );
          case "superseded":
            return sendError(
              reply,
              409,
              "SESSION_SUPERSEDED",
              "Se inició otra sesión mientras se preparaba esta.",
            );
          case "unavailable":
            return sendError(
              reply,
              503,
              "ACCESS_CHECK_UNAVAILABLE",
              "No fue posible comprobar tu acceso a SIBIA en este momento.",
            );
        }
      });

      web.post<{ Body: ChatBody }>(
        "/chat",
        {
          schema: {
            body: {
              type: "object",
              additionalProperties: false,
              required: ["message"],
              properties: {
                message: {
                  type: "string",
                  minLength: 1,
                  maxLength: MAX_MESSAGE_CHARACTERS,
                },
              },
            },
          },
        },
        async (request, reply) => {
          const auth = await authenticate(channel!, request, reply);
          if (auth === null) {
            return reply;
          }
          if (request.body.message.trim() === "") {
            return sendError(
              reply,
              400,
              "EMPTY_MESSAGE",
              "Escribe una pregunta para poder ayudarte.",
            );
          }

          const result = await channel!.sessions.send(
            auth.identity,
            auth.accessToken,
            request.body.message,
          );
          switch (result.status) {
            case "ok":
              return { status: "ok" as const, reply: result.reply };
            case "no_session":
            case "closed":
              return sendError(
                reply,
                401,
                "SESSION_NOT_FOUND",
                "Tu sesión de SIBIA terminó. Vuelve a iniciar sesión.",
              );
            case "busy":
              return sendError(
                reply,
                429,
                "CONVERSATION_BUSY",
                "SIBIA todavía está respondiendo tu consulta anterior.",
              );
            case "failed":
              return sendError(
                reply,
                502,
                "AGENT_FAILED",
                "SIBIA no pudo completar la consulta. Intenta de nuevo.",
              );
          }
        },
      );

      web.delete("/session", async (request, reply) => {
        const auth = await authenticate(channel!, request, reply);
        if (auth === null) {
          return reply;
        }
        channel!.sessions.close(auth.identity);
        return reply.code(204).send();
      });
    },
    { prefix: "/api/web" },
  );
}
