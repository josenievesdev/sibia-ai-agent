import { stdin, stdout } from "node:process";
import { emitKeypressEvents, type Key } from "node:readline";
import { createInterface } from "node:readline/promises";

export class ConsoleInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleInputError";
  }
}

export function ensureInteractiveConsole(): void {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new ConsoleInputError(
      "Este comando requiere una consola interactiva para ocultar la contraseña.",
    );
  }
}

export interface ConsoleReader {
  ask(prompt: string): Promise<string>;
  close(): void;
}

/*
 * Lector de una sola interfaz de readline para toda la sesión. Abrir y
 * cerrar una interfaz por cada línea deja stdin en pausa entre
 * preguntas y una línea vacía puede terminar la entrada: aquí la
 * interfaz vive mientras dura el chat y solo se cierra al salir.
 */
export function createConsoleReader(): ConsoleReader {
  const terminal = createInterface({ input: stdin, output: stdout });
  let finished = false;

  const finishedInput = new Promise<never>((_resolve, reject) => {
    terminal.once("SIGINT", () => {
      finished = true;
      terminal.close();
      reject(new ConsoleInputError("Operación cancelada."));
    });
    terminal.once("close", () => {
      finished = true;
      reject(new ConsoleInputError("La entrada de la consola terminó."));
    });
  });
  /* Nadie espera esta promesa cuando el cierre es voluntario. */
  finishedInput.catch(() => undefined);

  return {
    async ask(prompt: string): Promise<string> {
      if (finished) {
        throw new ConsoleInputError("La entrada de la consola terminó.");
      }
      return (
        await Promise.race([terminal.question(prompt), finishedInput])
      ).trim();
    },
    close(): void {
      if (!finished) {
        finished = true;
        terminal.close();
      }
    },
  };
}

export async function askText(prompt: string): Promise<string> {
  const terminal = createInterface({ input: stdin, output: stdout });
  const cancellation = new Promise<never>((_resolve, reject) => {
    terminal.once("SIGINT", () => {
      reject(new ConsoleInputError("Operación cancelada."));
    });
  });

  try {
    return (
      await Promise.race([terminal.question(prompt), cancellation])
    ).trim();
  } finally {
    terminal.close();
  }
}

export async function askHiddenPassword(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = "";
    const previousRawMode = stdin.isRaw;

    function cleanup(): void {
      stdin.off("keypress", onKeypress);
      stdin.off("error", onError);
      stdin.off("end", onEnd);
      stdin.setRawMode(previousRawMode);
      stdin.pause();
    }

    function fail(message: string): void {
      value = "";
      cleanup();
      stdout.write("\n");
      reject(new ConsoleInputError(message));
    }

    function onError(): void {
      fail("No fue posible leer la contraseña desde la consola.");
    }

    function onEnd(): void {
      fail("La entrada terminó antes de recibir la contraseña.");
    }

    function onKeypress(character: string | undefined, key: Key): void {
      if (key.ctrl && key.name === "c") {
        fail("Operación cancelada.");
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const password = value;
        value = "";
        cleanup();
        stdout.write("\n");
        resolve(password);
        return;
      }

      if (key.name === "backspace") {
        const characters = Array.from(value);
        characters.pop();
        value = characters.join("");
        return;
      }

      if (
        character !== undefined &&
        !key.ctrl &&
        !key.meta &&
        !/[\u0000-\u001f\u007f]/u.test(character)
      ) {
        value += character;
      }
    }

    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKeypress);
    stdin.once("error", onError);
    stdin.once("end", onEnd);
    stdout.write("Contraseña: ");
  });
}
