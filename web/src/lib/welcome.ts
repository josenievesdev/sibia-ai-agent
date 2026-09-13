/*
 * Texto de la interfaz, no respuestas de SIBIA: no pasan por el agente ni
 * mencionan datos del negocio.
 */
export const WELCOME_GREETINGS = [
  "Hola, soy SIBIA. ¿En qué puedo ayudarte?",
  "Hola, soy SIBIA. ¿Qué quieres consultar hoy?",
  "Hola, soy SIBIA. Cuéntame qué necesitas saber.",
] as const;

export const WELCOME_TEXT =
  "Pregúntame en lenguaje natural y te respondo con la información de tu negocio.";

export function pickWelcomeGreeting(random: () => number = Math.random): string {
  const index = Math.floor(random() * WELCOME_GREETINGS.length);
  return WELCOME_GREETINGS[index] ?? WELCOME_GREETINGS[0];
}
