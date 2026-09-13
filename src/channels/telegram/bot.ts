import {
  TelegramApiError,
  type TelegramClient,
  type TelegramMessage,
  type TelegramUpdate,
} from "./client.js";
import { formatTelegramText, splitTelegramText } from "./format.js";

/*
 * Este canal no interpreta preguntas: solo separa los comandos propios
 * de Telegram y entrega cualquier otro texto al agente existente.
 */

export interface TelegramConversationAgent {
  respond(message: string): Promise<{ text: string }>;
}

export interface TelegramAgentFactory {
  initialize(): Promise<void>;
  createAgent(): Promise<TelegramConversationAgent>;
  close(): Promise<void>;
}

export type TelegramBotEventArea =
  | "agent"
  | "initialization"
  | "polling"
  | "shutdown"
  | "telegram"
  | "typing";

export interface TelegramBotOptions {
  allowedUserIds: ReadonlySet<number>;
  businessName: string;
  onEvent?: (area: TelegramBotEventArea) => void;
  pollingErrorDelayMs?: number;
  typingIntervalMs?: number;
}

const MAX_REMEMBERED_UPDATE_IDS = 2_000;
const UNAUTHORIZED_MESSAGE = "Este usuario no está autorizado para usar SIBIA.";
const UNAVAILABLE_MESSAGE =
  "SIBIA no está disponible en este momento. Puedes intentarlo de nuevo.";
const TEXT_ONLY_MESSAGE =
  "Esta primera versión de SIBIA procesa únicamente mensajes de texto.";

type TelegramCommand = "ayuda" | "id" | "reiniciar" | "salir" | "start";

class UpdateSkippedOnShutdownError extends Error {
  constructor() {
    super("Update omitido durante el apagado.");
    this.name = "UpdateSkippedOnShutdownError";
  }
}

function commandFromText(text: string): TelegramCommand | null {
  const match = text
    .trim()
    .match(/^\/(ayuda|id|reiniciar|salir|start)(?:@[A-Za-z0-9_]+)?(?:\s.*)?$/isu);
  return (match?.[1]?.toLocaleLowerCase("es") as TelegramCommand | undefined) ?? null;
}

function hasUnsupportedMedia(message: TelegramMessage): boolean {
  return (
    message.animation !== undefined ||
    message.audio !== undefined ||
    message.document !== undefined ||
    message.photo !== undefined ||
    message.sticker !== undefined ||
    message.video !== undefined ||
    message.video_note !== undefined ||
    message.voice !== undefined
  );
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });

    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

export class TelegramBot {
  private readonly agents = new Map<number, TelegramConversationAgent>();
  private readonly allowedUserIds: ReadonlySet<number>;
  private readonly businessName: string;
  private readonly onEvent: (area: TelegramBotEventArea) => void;
  private readonly pollingErrorDelayMs: number;
  private readonly typingIntervalMs: number;
  private readonly queues = new Map<number, Promise<void>>();
  private readonly seenUpdateIds = new Set<number>();
  private readonly seenUpdateOrder: number[] = [];

  constructor(
    private readonly client: TelegramClient,
    private readonly agentFactory: TelegramAgentFactory,
    options: TelegramBotOptions,
  ) {
    this.allowedUserIds = options.allowedUserIds;
    this.businessName = options.businessName;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.pollingErrorDelayMs = options.pollingErrorDelayMs ?? 1_000;
    this.typingIntervalMs = options.typingIntervalMs ?? 4_000;
  }

  async run(signal: AbortSignal): Promise<void> {
    try {
      try {
        await this.agentFactory.initialize();
      } catch {
        this.report("initialization");
      }

      let offset = 0;
      let consecutivePollingFailures = 0;
      while (!signal.aborted) {
        let updates: readonly TelegramUpdate[];
        try {
          updates = await this.client.getUpdates(offset, signal);
          consecutivePollingFailures = 0;
        } catch (error) {
          if (signal.aborted) {
            await this.acknowledgeCompletedOffset(offset);
            break;
          }
          if (error instanceof TelegramApiError && !error.retryable) {
            throw error;
          }
          this.report("polling");
          consecutivePollingFailures += 1;
          const delay =
            error instanceof TelegramApiError && error.retryAfterMs !== null
              ? error.retryAfterMs
              : Math.min(
                  this.pollingErrorDelayMs *
                    2 ** (consecutivePollingFailures - 1),
                  30_000,
                );
          await waitFor(delay, signal);
          continue;
        }

        const orderedUpdates = [...updates].sort(
          (left, right) => left.update_id - right.update_id,
        );
        const batch: Promise<void>[] = [];
        for (const update of orderedUpdates) {
          batch.push(this.handleUpdate(update, signal));
        }
        /*
         * Telegram confirma el offset en la siguiente llamada. Esperar el
         * lote evita confirmar trabajo que todavía vive solo en memoria;
         * usuarios distintos siguen ejecutándose en paralelo dentro del lote.
         */
        const results = await Promise.allSettled(batch);
        for (let index = 0; index < results.length; index += 1) {
          if (results[index]?.status !== "fulfilled") {
            break;
          }
          offset = Math.max(offset, orderedUpdates[index]!.update_id + 1);
        }

        if (signal.aborted) {
          await this.acknowledgeCompletedOffset(offset);
          break;
        }
      }
    } finally {
      await Promise.allSettled([...this.queues.values()]);
      this.agents.clear();
      try {
        await this.agentFactory.close();
      } catch {
        this.report("shutdown");
      }
    }
  }

  handleUpdate(
    update: TelegramUpdate,
    shutdownSignal?: AbortSignal,
  ): Promise<void> {
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      return Promise.resolve();
    }
    if (this.seenUpdateIds.has(update.update_id)) {
      return Promise.resolve();
    }
    this.rememberUpdate(update.update_id);

    const userId = update.message?.from?.id;
    if (typeof userId !== "number" || !Number.isSafeInteger(userId)) {
      return Promise.resolve();
    }
    return this.enqueue(userId, async () => {
      if (shutdownSignal?.aborted === true) {
        throw new UpdateSkippedOnShutdownError();
      }
      await this.processSafely(update);
    });
  }

  private enqueue(userId: number, action: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const current = previous.then(action, action);
    this.queues.set(userId, current);
    void current.then(
      () => this.removeQueue(userId, current),
      () => this.removeQueue(userId, current),
    );
    return current;
  }

  private removeQueue(userId: number, current: Promise<void>): void {
    if (this.queues.get(userId) === current) {
      this.queues.delete(userId);
    }
  }

  private async processSafely(update: TelegramUpdate): Promise<void> {
    try {
      await this.processUpdate(update);
    } catch (error) {
      if (error instanceof TelegramApiError) {
        this.report("telegram");
        return;
      }
      this.report("agent");
      const chatId = update.message?.chat?.id;
      if (chatId !== undefined) {
        await this.trySend(chatId, UNAVAILABLE_MESSAGE);
      }
    }
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    const user = message?.from;
    if (
      message === undefined ||
      user === undefined ||
      user.is_bot === true ||
      message.chat.type !== "private"
    ) {
      return;
    }

    const text = message.text;
    const command = text === undefined ? null : commandFromText(text);
    if (command === "id") {
      await this.send(message.chat.id, String(user.id));
      return;
    }

    if (!this.allowedUserIds.has(user.id)) {
      await this.send(message.chat.id, UNAUTHORIZED_MESSAGE);
      return;
    }

    if (command !== null) {
      await this.processCommand(command, message.chat.id, user.id);
      return;
    }

    if (text === undefined) {
      if (hasUnsupportedMedia(message)) {
        await this.send(message.chat.id, TEXT_ONLY_MESSAGE);
      }
      return;
    }

    let agent = this.agents.get(user.id);
    if (agent === undefined) {
      agent = await this.agentFactory.createAgent();
      this.agents.set(user.id, agent);
    }

    try {
      const response = await this.withTyping(message.chat.id, () =>
        agent.respond(text),
      );
      await this.send(message.chat.id, response.text);
    } catch (error) {
      /*
       * El agente confirma su memoria antes de que Telegram confirme la
       * entrega. Si esta falla, se descarta solo esta conversación para no
       * resolver referencias futuras contra una respuesta que no se vio.
       */
      this.agents.delete(user.id);
      throw error;
    }
  }

  private async processCommand(
    command: TelegramCommand,
    chatId: number,
    userId: number,
  ): Promise<void> {
    switch (command) {
      case "start":
        await this.send(
          chatId,
          `SIBIA es el asistente de inventario de ${this.businessName}. Puedes consultar productos, existencias, precios, proveedores y el estado general del inventario. Usa /ayuda para ver más información.`,
        );
        return;
      case "ayuda":
        await this.send(
          chatId,
          [
            "Puedes preguntarle a SIBIA, con texto y lenguaje natural, por:",
            "- productos y precios de venta",
            "- stock registrado y stock bajo",
            "- proveedores asociados a un producto",
            "- listados y resumen general del inventario",
            "",
            "/reiniciar borra tu memoria conversacional.",
            "/salir borra tu conversación.",
            "/id muestra tu ID de Telegram.",
          ].join("\n"),
        );
        return;
      case "reiniciar":
        this.agents.delete(userId);
        await this.send(chatId, "Tu memoria conversacional fue reiniciada.");
        return;
      case "salir":
        this.agents.delete(userId);
        await this.send(chatId, "Hasta luego. Tu conversación fue eliminada.");
        return;
      case "id":
        return;
    }
  }

  private async withTyping<T>(
    chatId: number,
    action: () => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const typing = this.typingLoop(chatId, controller.signal);
    try {
      return await action();
    } finally {
      controller.abort();
      await typing;
    }
  }

  private async typingLoop(chatId: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.client.sendChatAction(chatId, "typing", signal);
      } catch {
        this.report("typing");
      }
      await waitFor(this.typingIntervalMs, signal);
    }
  }

  private async send(chatId: number, value: string): Promise<void> {
    const text = formatTelegramText(value);
    const chunks = splitTelegramText(text);
    if (chunks.length === 0) {
      throw new Error("La respuesta quedó vacía después de adaptarla a Telegram.");
    }
    for (const chunk of chunks) {
      await this.client.sendMessage(chatId, chunk);
    }
  }

  private async trySend(chatId: number, value: string): Promise<void> {
    try {
      await this.send(chatId, value);
    } catch {
      this.report("telegram");
    }
  }

  private rememberUpdate(updateId: number): void {
    this.seenUpdateIds.add(updateId);
    this.seenUpdateOrder.push(updateId);
    if (this.seenUpdateOrder.length <= MAX_REMEMBERED_UPDATE_IDS) {
      return;
    }
    const oldest = this.seenUpdateOrder.shift();
    if (oldest !== undefined) {
      this.seenUpdateIds.delete(oldest);
    }
  }

  private async acknowledgeCompletedOffset(offset: number): Promise<void> {
    if (offset <= 0) {
      return;
    }
    try {
      await this.client.getUpdates(offset, AbortSignal.timeout(2_000), 0);
    } catch {
      this.report("shutdown");
    }
  }

  private report(area: TelegramBotEventArea): void {
    try {
      this.onEvent(area);
    } catch {
      // El diagnóstico del canal nunca debe interrumpir el bot.
    }
  }
}
