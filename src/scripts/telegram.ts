import { TelegramBot, type TelegramBotEventArea } from "../channels/telegram/bot.js";
import {
  TelegramApiError,
  TelegramHttpClient,
} from "../channels/telegram/client.js";
import { loadTelegramConfig } from "../channels/telegram/config.js";
import { TelegramSibiaAgentFactory } from "../channels/telegram/sibia-agent-factory.js";
import { ConfigurationError } from "../config/env.js";

function debugEvent(area: TelegramBotEventArea): void {
  console.error(`[sibia:telegram] ${JSON.stringify({ evento: area })}`);
}

function reportEvent(area: TelegramBotEventArea, debug: boolean): void {
  if (debug) {
    debugEvent(area);
  } else if (area === "initialization") {
    console.error(
      "SIBIA Telegram: la cuenta dedicada de Supabase no está disponible; /id seguirá activo y las consultas se rechazarán de forma segura.",
    );
  }
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadTelegramConfig();
  } catch (error) {
    console.error(
      `SIBIA Telegram: ${
        error instanceof ConfigurationError
          ? error.message
          : "No fue posible leer la configuración."
      }`,
    );
    process.exitCode = 2;
    return;
  }

  const debug = config.app.ollama.debug || process.argv.includes("--debug");
  const client = new TelegramHttpClient(config.botToken, { debug });
  const factory = new TelegramSibiaAgentFactory({
    businessName: config.app.businessName,
    integrationCheckTimeoutMs: config.app.integrationCheckTimeoutMs,
    ollama: { ...config.app.ollama, debug },
    supabase: config.app.supabase,
    supabaseEmail: config.supabaseEmail,
    supabasePassword: config.supabasePassword,
  });
  const bot = new TelegramBot(client, factory, {
    allowedUserIds: config.allowedUserIds,
    businessName: config.app.businessName,
    onEvent: (area) => reportEvent(area, debug),
  });

  const controller = new AbortController();
  const stop = (): void => {
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    console.log("SIBIA Telegram: long polling local iniciado.");
    await bot.run(controller.signal);
  } catch (error) {
    console.error(
      error instanceof TelegramApiError
        ? "SIBIA Telegram: Telegram rechazó el polling. Verifica el token y que no exista otro polling o webhook activo."
        : "SIBIA Telegram: el bot se detuvo por un fallo inesperado.",
    );
    process.exitCode ||= 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

await main();
