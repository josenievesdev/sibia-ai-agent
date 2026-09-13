import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

/*
 * Destino del proxy /api hacia Fastify. Del .env del backend solo se leen
 * APP_HOST y PORT; ninguna otra variable llega a Vite ni al navegador.
 */
function apiTarget(): string {
  const explicit = process.env.SIBIA_WEB_API_TARGET?.trim();
  if (explicit) {
    return explicit;
  }

  let host = "127.0.0.1";
  let port = "3000";
  try {
    const env = parseEnv(
      readFileSync(new URL("../.env", import.meta.url), "utf8"),
    );
    host = env.APP_HOST?.trim() || host;
    port = env.PORT?.trim() || port;
  } catch {
    // Sin .env se usan los valores predeterminados del backend.
  }
  if (host === "0.0.0.0" || host === "::") {
    host = "127.0.0.1";
  }
  return `http://${host}:${port}`;
}

const proxy = { "/api": { target: apiTarget() } };

export default defineConfig({
  root: webRoot,
  // Solo se buscan archivos .env dentro de web/, nunca el .env del backend.
  envDir: webRoot,
  plugins: [react()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true, proxy },
  build: {
    outDir: fileURLToPath(new URL("../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
