import { describe, expect, it } from "vitest";

import { ApiError, createApiClient } from "../src/lib/api-client";

function recordingFetch(response: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { calls, fetchStub };
}

describe("cliente HTTP del canal web", () => {
  it("envía la consulta con Bearer y devuelve el texto del agente sin cambios", async () => {
    const { calls, fetchStub } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ status: "ok", reply: { status: "ok", text: "**Hola**" } }),
          { status: 200 },
        ),
    );
    const api = createApiClient({ fetch: fetchStub });

    const reply = await api.sendMessage("token-valido", "¿Qué hay?");

    expect(reply).toEqual({ status: "ok", text: "**Hola**" });
    expect(calls[0]?.url).toBe("/api/web/chat");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer token-valido");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ message: "¿Qué hay?" }));
  });

  it("traduce un 401 del backend a una sesión no autorizada", async () => {
    const { fetchStub } = recordingFetch(
      () =>
        new Response(
          JSON.stringify({ status: "error", code: "SESSION_NOT_FOUND", message: "Fin." }),
          { status: 401 },
        ),
    );
    const api = createApiClient({ fetch: fetchStub });

    const error = await api.sendMessage("token-vencido", "hola").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: "unauthorized", code: "SESSION_NOT_FOUND" });
  });
});
