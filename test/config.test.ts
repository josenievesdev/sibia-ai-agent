import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigurationError,
  loadConfig,
  SIBIA_OLLAMA_MODEL,
} from "../src/config/env.js";

test("uses safe local defaults without Supabase credentials", () => {
  const config = loadConfig({});

  assert.equal(config.ollama.model, SIBIA_OLLAMA_MODEL);
  assert.equal(config.supabase, null);
  assert.equal(config.host, "127.0.0.1");
});

test("rejects partial Supabase configuration", () => {
  assert.throws(
    () => loadConfig({ SUPABASE_URL: "https://example.supabase.co" }),
    ConfigurationError,
  );
});

test("rejects a different Ollama model", () => {
  assert.throws(
    () => loadConfig({ OLLAMA_MODEL: "another-model" }),
    ConfigurationError,
  );
});

test("rejects modern Supabase secret keys", () => {
  assert.throws(
    () =>
      loadConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: "sb_secret_not-a-real-key",
      }),
    ConfigurationError,
  );
});

test("rejects legacy service_role JWTs", () => {
  const payload = Buffer.from(
    JSON.stringify({ role: "service_role" }),
  ).toString("base64url");

  assert.throws(
    () =>
      loadConfig({
        SUPABASE_URL: "https://example.supabase.co",
        SUPABASE_PUBLISHABLE_KEY: `header.${payload}.signature`,
      }),
    ConfigurationError,
  );
});

test("SIBIA_BUSINESS_NAME configura el negocio y cae en un valor neutro", () => {
  assert.equal(loadConfig({}).businessName, "esta tienda");
  assert.equal(loadConfig({ SIBIA_BUSINESS_NAME: "   " }).businessName, "esta tienda");
  assert.equal(
    loadConfig({ SIBIA_BUSINESS_NAME: "  Tienda La Esquina  " }).businessName,
    "Tienda La Esquina",
  );
  /* El valor se imprime y viaja en el prompt: sin saltos de línea. */
  assert.equal(
    loadConfig({ SIBIA_BUSINESS_NAME: "Tienda\nLa Esquina" }).businessName,
    "Tienda La Esquina",
  );
  assert.throws(
    () => loadConfig({ SIBIA_BUSINESS_NAME: "N".repeat(61) }),
    ConfigurationError,
  );
});
