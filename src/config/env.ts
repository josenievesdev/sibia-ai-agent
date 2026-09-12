import { DEFAULT_BUSINESS_NAME } from "../ai/system-prompt.js";

export const SIBIA_OLLAMA_MODEL = "ministral-3:8b" as const;

const LOG_LEVELS = [
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export interface AppConfig {
  businessName: string;
  host: string;
  port: number;
  logLevel: LogLevel;
  integrationCheckTimeoutMs: number;
  ollama: {
    baseUrl: string;
    chatTimeoutMs: number;
    debug: boolean;
    model: typeof SIBIA_OLLAMA_MODEL;
    numCtx: number;
  };
  supabase: SupabaseConfig | null;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function optionalValue(
  environment: NodeJS.ProcessEnv,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function valueOrDefault(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: string,
): string {
  return optionalValue(environment, name) ?? defaultValue;
}

function parseInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = optionalValue(environment, name);
  if (rawValue === undefined) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `${name} debe ser un entero entre ${minimum} y ${maximum}.`,
    );
  }

  return value;
}

function parseBoolean(environment: NodeJS.ProcessEnv, name: string): boolean {
  const rawValue = optionalValue(environment, name)?.toLowerCase();
  return rawValue === "1" || rawValue === "true";
}

/*
 * Nombre del negocio que la consola muestra en la bienvenida y que el
 * prompt del sistema usa para que SIBIA se identifique igual. Se
 * limpian los saltos de línea y los caracteres de control porque el
 * valor se imprime en la consola y viaja dentro del prompt.
 */
const MAX_BUSINESS_NAME_CHARACTERS = 60;

function parseBusinessName(environment: NodeJS.ProcessEnv): string {
  const rawValue = optionalValue(environment, "SIBIA_BUSINESS_NAME");
  if (rawValue === undefined) {
    return DEFAULT_BUSINESS_NAME;
  }

  const value = rawValue.replace(/[\p{C}]+/gu, " ").replace(/\s+/gu, " ").trim();
  if (value === "") {
    return DEFAULT_BUSINESS_NAME;
  }
  if (value.length > MAX_BUSINESS_NAME_CHARACTERS) {
    throw new ConfigurationError(
      `SIBIA_BUSINESS_NAME no puede superar ${MAX_BUSINESS_NAME_CHARACTERS} caracteres.`,
    );
  }
  return value;
}

function parseHttpUrl(name: string, value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} debe ser una URL válida.`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(`${name} debe usar http o https.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(`${name} no puede incluir credenciales.`);
  }

  return url.toString().replace(/\/$/, "");
}

function parseSupabaseUrl(value: string): string {
  const normalized = parseHttpUrl("SUPABASE_URL", value);
  const url = new URL(normalized);
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";

  if (url.protocol !== "https:" && !loopback) {
    throw new ConfigurationError(
      "SUPABASE_URL debe usar https fuera del entorno local.",
    );
  }
  return normalized;
}

function parseLogLevel(environment: NodeJS.ProcessEnv): LogLevel {
  const value = valueOrDefault(environment, "LOG_LEVEL", "info");
  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new ConfigurationError(
      `LOG_LEVEL debe ser uno de: ${LOG_LEVELS.join(", ")}.`,
    );
  }

  return value as LogLevel;
}

function isLegacyServiceRoleKey(key: string): boolean {
  const segments = key.split(".");
  const payload = segments[1];
  if (segments.length !== 3 || payload === undefined) {
    return false;
  }

  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return (
      typeof claims === "object" &&
      claims !== null &&
      "role" in claims &&
      claims.role === "service_role"
    );
  } catch {
    return false;
  }
}

function assertPublishableSupabaseKey(key: string): void {
  if (key.startsWith("sb_secret_") || isLegacyServiceRoleKey(key)) {
    throw new ConfigurationError(
      "SUPABASE_PUBLISHABLE_KEY no puede contener una clave secret ni service_role; usa la publishable key del nuevo proyecto.",
    );
  }
}

function parseSupabaseConfig(
  environment: NodeJS.ProcessEnv,
): SupabaseConfig | null {
  const url = optionalValue(environment, "SUPABASE_URL");
  const publishableKey = optionalValue(
    environment,
    "SUPABASE_PUBLISHABLE_KEY",
  );

  if (url === undefined && publishableKey === undefined) {
    return null;
  }

  if (url === undefined || publishableKey === undefined) {
    throw new ConfigurationError(
      "SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY deben configurarse juntas o dejarse ambas vacías.",
    );
  }

  assertPublishableSupabaseKey(publishableKey);

  return {
    url: parseSupabaseUrl(url),
    publishableKey,
  };
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const model = valueOrDefault(
    environment,
    "OLLAMA_MODEL",
    SIBIA_OLLAMA_MODEL,
  );

  if (model !== SIBIA_OLLAMA_MODEL) {
    throw new ConfigurationError(
      `OLLAMA_MODEL debe ser exactamente ${SIBIA_OLLAMA_MODEL}; SIBIA no cambia ni descarga modelos automáticamente.`,
    );
  }

  return {
    businessName: parseBusinessName(environment),
    host: valueOrDefault(environment, "APP_HOST", "127.0.0.1"),
    port: parseInteger(environment, "PORT", 3000, 1, 65_535),
    logLevel: parseLogLevel(environment),
    integrationCheckTimeoutMs: parseInteger(
      environment,
      "INTEGRATION_CHECK_TIMEOUT_MS",
      5_000,
      250,
      60_000,
    ),
    ollama: {
      baseUrl: parseHttpUrl(
        "OLLAMA_BASE_URL",
        valueOrDefault(
          environment,
          "OLLAMA_BASE_URL",
          "http://127.0.0.1:11434",
        ),
      ),
      chatTimeoutMs: parseInteger(
        environment,
        "OLLAMA_CHAT_TIMEOUT_MS",
        120_000,
        1_000,
        600_000,
      ),
      debug: parseBoolean(environment, "SIBIA_DEBUG"),
      model,
      /*
       * El valor por defecto de Ollama (4096) no alcanza para el prompt
       * de SIBIA más las definiciones de tools y un resultado de tool:
       * Ollama recorta el prompt en silencio y corta las llamadas a
       * tool a medio escribir.
       *
       * 6144 es el mayor valor medido que mantiene ministral-3:8b al
       * 100 % en GPU en esta máquina; con 8192 se reparte entre CPU y
       * GPU, va mucho más lento y las recargas del runner devuelven
       * turnos incompletos. Ajustable con OLLAMA_NUM_CTX según la VRAM.
       */
      numCtx: parseInteger(environment, "OLLAMA_NUM_CTX", 6_144, 2_048, 131_072),
    },
    supabase: parseSupabaseConfig(environment),
  };
}
