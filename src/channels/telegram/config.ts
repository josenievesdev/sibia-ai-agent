import {
  ConfigurationError,
  loadConfig,
  type AppConfig,
  type SupabaseConfig,
} from "../../config/env.js";

export interface TelegramConfig {
  app: Omit<AppConfig, "supabase"> & { supabase: SupabaseConfig };
  botToken: string;
  allowedUserIds: ReadonlySet<number>;
  supabaseEmail: string;
  supabasePassword: string;
}

function requiredTrimmedValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value === "") {
    throw new ConfigurationError(`${name} es obligatorio para ejecutar Telegram.`);
  }
  return value;
}

function requiredSecret(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigurationError(`${name} es obligatorio para ejecutar Telegram.`);
  }
  if (/\r|\n|\0/u.test(value)) {
    throw new ConfigurationError(`${name} contiene caracteres no permitidos.`);
  }
  return value;
}

function parseBotToken(environment: NodeJS.ProcessEnv): string {
  const token = requiredTrimmedValue(environment, "TELEGRAM_BOT_TOKEN");
  if (!/^\d+:[A-Za-z0-9_-]+$/u.test(token)) {
    throw new ConfigurationError("TELEGRAM_BOT_TOKEN no tiene un formato válido.");
  }
  return token;
}

function parseAllowedUserIds(
  environment: NodeJS.ProcessEnv,
): ReadonlySet<number> {
  const rawValue = environment.TELEGRAM_ALLOWED_USER_IDS?.trim() ?? "";
  if (rawValue === "") {
    return new Set<number>();
  }

  const ids = new Set<number>();
  for (const rawId of rawValue.split(/[\s,]+/u)) {
    if (!/^\d+$/u.test(rawId)) {
      throw new ConfigurationError(
        "TELEGRAM_ALLOWED_USER_IDS debe contener IDs numéricos separados por comas.",
      );
    }
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ConfigurationError(
        "TELEGRAM_ALLOWED_USER_IDS contiene un ID fuera del rango permitido.",
      );
    }
    ids.add(id);
  }
  return ids;
}

export function loadTelegramConfig(
  environment: NodeJS.ProcessEnv = process.env,
): TelegramConfig {
  const app = loadConfig(environment);
  if (app.supabase === null) {
    throw new ConfigurationError(
      "SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY son obligatorias para ejecutar Telegram.",
    );
  }

  const email = requiredTrimmedValue(environment, "TELEGRAM_SUPABASE_EMAIL");
  if (email.length > 320 || /[\p{C}\s]/u.test(email)) {
    throw new ConfigurationError("TELEGRAM_SUPABASE_EMAIL no tiene un formato válido.");
  }

  return {
    app: { ...app, supabase: app.supabase },
    botToken: parseBotToken(environment),
    allowedUserIds: parseAllowedUserIds(environment),
    supabaseEmail: email,
    supabasePassword: requiredSecret(
      environment,
      "TELEGRAM_SUPABASE_PASSWORD",
    ),
  };
}
