import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ConfigurationError,
  loadConfig,
  type AppConfig,
} from "../config/env.js";
import { createSupabaseConnection } from "../integrations/supabase/client.js";
import {
  ConsoleInputError,
  askHiddenPassword,
  askText,
  ensureInteractiveConsole,
} from "./interactive-input.js";

export type InteractiveSessionErrorCode =
  | "authentication_failed"
  | "configuration_error"
  | "connection_error"
  | "not_configured"
  | "sign_out_error";

export class InteractiveSessionError extends Error {
  readonly code: InteractiveSessionErrorCode;
  readonly exitCode: number;

  constructor(
    code: InteractiveSessionErrorCode,
    message: string,
    exitCode: number,
  ) {
    super(message);
    this.name = "InteractiveSessionError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export async function withInteractiveSupabaseSession<T>(
  action: (client: SupabaseClient, config: AppConfig) => Promise<T>,
): Promise<T> {
  let password = "";
  let actionFailed = false;

  try {
    let config: AppConfig;
    try {
      config = loadConfig();
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw new InteractiveSessionError(
          "configuration_error",
          error.message,
          2,
        );
      }
      throw error;
    }

    if (config.supabase === null) {
      throw new InteractiveSessionError(
        "not_configured",
        "Faltan SUPABASE_URL y SUPABASE_PUBLISHABLE_KEY en el entorno.",
        2,
      );
    }

    ensureInteractiveConsole();
    const email = await askText("Correo: ");
    password = await askHiddenPassword();

    if (email === "" || password === "") {
      throw new ConsoleInputError("Correo y contraseña son obligatorios.");
    }

    const client = createSupabaseConnection(config.supabase);
    let authenticated = false;

    try {
      const { error: authenticationError } =
        await client.auth
          .signInWithPassword({ email, password })
          .catch(() => {
            throw new InteractiveSessionError(
              "connection_error",
              "No fue posible conectar con Supabase Auth.",
              3,
            );
          });
      password = "";

      if (authenticationError !== null) {
        const authenticationStatus = authenticationError.status;
        const connectionFailure =
          authenticationError.name === "AuthRetryableFetchError" ||
          authenticationStatus === 0 ||
          (authenticationStatus !== undefined && authenticationStatus >= 500);

        throw new InteractiveSessionError(
          connectionFailure ? "connection_error" : "authentication_failed",
          connectionFailure
            ? "No fue posible conectar con Supabase Auth."
            : "Supabase Auth rechazó el correo o la contraseña.",
          3,
        );
      }

      authenticated = true;

      try {
        return await action(client, config);
      } catch (error) {
        actionFailed = true;
        throw error;
      }
    } finally {
      password = "";

      if (authenticated) {
        let signOutFailed = false;

        try {
          const { error: signOutError } = await client.auth.signOut({
            scope: "local",
          });
          signOutFailed = signOutError !== null;
        } catch {
          signOutFailed = true;
        }

        if (signOutFailed && !actionFailed) {
          throw new InteractiveSessionError(
            "sign_out_error",
            "No fue posible confirmar el cierre de sesión en Supabase Auth.",
            6,
          );
        }
      }
    }
  } finally {
    password = "";
  }
}
