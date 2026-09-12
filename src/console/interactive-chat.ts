import { DEFAULT_BUSINESS_NAME } from "../ai/system-prompt.js";
import { createConsoleReader } from "./interactive-input.js";

export interface InteractiveChatAgent {
  respond(message: string): Promise<{ text: string }>;
}

export interface InteractiveChatOptions {
  businessName?: string;
  ask?: (prompt: string) => Promise<string>;
}

/*
 * Bienvenida de la consola. Es texto de la interfaz, no una respuesta
 * de SIBIA: no pasa por el modelo ni entra en el historial. Se dibuja
 * con texto plano, sin dependencias.
 */
export function welcomeBanner(
  businessName: string = DEFAULT_BUSINESS_NAME,
): string {
  const business =
    businessName.trim() === "" ? DEFAULT_BUSINESS_NAME : businessName.trim();

  return [
    "SIBIA",
    `Asistente inteligente de inventario de ${business}`,
    "",
    "Sesión segura iniciada.",
    "Puedes consultar productos, existencias, precios, proveedores y el estado general del inventario.",
    "Escribe tu consulta de forma natural o usa /salir para terminar.",
  ].join("\n");
}

export async function runInteractiveChat(
  agent: InteractiveChatAgent,
  options: InteractiveChatOptions = {},
): Promise<void> {
  const reader = options.ask === undefined ? createConsoleReader() : null;
  const ask = options.ask ?? ((prompt: string) => reader!.ask(prompt));
  console.log(welcomeBanner(options.businessName));
  console.log("");

  try {
    while (true) {
      const message = await ask("Tú: ");
      if (message.toLocaleLowerCase("es") === "/salir") {
        console.log("SIBIA: Hasta luego.");
        return;
      }
      /*
       * Una línea vacía no es una orden ni un mensaje: solo vuelve a
       * pedir la entrada. La única forma normal de cerrar es /salir.
       */
      if (message === "") {
        continue;
      }

      try {
        const response = await agent.respond(message);
        console.log(`SIBIA: ${response.text}`);
      } catch {
        console.log(
          "SIBIA: Ocurrió un fallo técnico en este turno. Puedes intentarlo de nuevo.",
        );
      }
    }
  } finally {
    reader?.close();
  }
}
