import { loadConfig } from "../config/env.js";
import { buildApp } from "./app.js";

async function start(): Promise<void> {
  const config = loadConfig();
  const app = buildApp(config);

  const close = async (signal: NodeJS.Signals): Promise<void> => {
    app.log.info({ signal }, "Cerrando SIBIA");
    await app.close();
  };

  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
}

try {
  await start();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`No se pudo iniciar SIBIA: ${message}`);
  process.exitCode = 1;
}
