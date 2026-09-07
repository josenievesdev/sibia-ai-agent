import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config/env.js";
import { buildApp } from "../src/http/app.js";

test("health reports only process health and honest dependency states", async () => {
  const app = buildApp(loadConfig({}), { logger: false });

  try {
    const response = await app.inject({ method: "GET", url: "/health" });
    const body: unknown = response.json();

    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      typeof body === "object" && body !== null && "externalDependencies" in body
        ? body.externalDependencies
        : null,
      {
        ollama: "not_checked",
        supabase: "not_configured",
      },
    );
  } finally {
    await app.close();
  }
});

test("Supabase endpoint distinguishes missing configuration", async () => {
  const app = buildApp(loadConfig({}), { logger: false });

  try {
    const response = await app.inject({
      method: "GET",
      url: "/checks/supabase",
    });
    const body: unknown = response.json();

    assert.equal(response.statusCode, 503);
    assert.equal(
      typeof body === "object" && body !== null && "status" in body
        ? body.status
        : null,
      "not_configured",
    );
  } finally {
    await app.close();
  }
});
