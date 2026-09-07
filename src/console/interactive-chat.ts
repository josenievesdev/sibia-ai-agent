import { askText } from "./interactive-input.js";

export interface InteractiveChatAgent {
  respond(message: string): Promise<{ text: string }>;
}

export async function runInteractiveChat(
  agent: InteractiveChatAgent,
): Promise<void> {
  console.log("SIBIA: Sesión iniciada. Escribe /salir para terminar.");

  while (true) {
    const message = await askText("Tú: ");
    if (message.toLocaleLowerCase("es") === "/salir") {
      console.log("SIBIA: Hasta luego.");
      return;
    }
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
}
