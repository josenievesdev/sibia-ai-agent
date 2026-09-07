import { loadConfig } from "../config/env.js";
import { buildApp } from "../http/app.js";

const config = loadConfig();
const app = buildApp(config, { logger: false });

try {
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const response = await fetch(`${address}/health`, {
    headers: { accept: "application/json" },
  });
  const body: unknown = await response.json();
  console.log(JSON.stringify(body, null, 2));

  const dependencies =
    typeof body === "object" &&
    body !== null &&
    "externalDependencies" in body &&
    typeof body.externalDependencies === "object" &&
    body.externalDependencies !== null
      ? body.externalDependencies
      : null;

  if (
    response.status !== 200 ||
    typeof body !== "object" ||
    body === null ||
    !("status" in body) ||
    body.status !== "ok" ||
    dependencies === null ||
    !("ollama" in dependencies) ||
    dependencies.ollama !== "not_checked" ||
    !("supabase" in dependencies) ||
    dependencies.supabase !==
      (config.supabase === null ? "not_configured" : "not_checked")
  ) {
    process.exitCode = 1;
  }
} finally {
  await app.close();
}
