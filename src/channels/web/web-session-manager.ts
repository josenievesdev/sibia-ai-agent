import type { ChatTurnStatus } from "../../ai/sibia-agent.js";
import type { WebIdentity } from "./web-auth.js";
import type {
  WebAgentFactory,
  WebConversationAgent,
} from "./web-agent-factory.js";

export type WebSessionOpenResult =
  | "forbidden"
  | "ready"
  | "superseded"
  | "unavailable";

export type WebTurnResult =
  | { status: "ok"; reply: { status: ChatTurnStatus; text: string } }
  | { status: "busy" }
  | { status: "closed" }
  | { status: "failed" }
  | { status: "no_session" };

export interface WebSessionManagerOptions {
  idleTimeoutMs?: number;
  maxPendingTurns?: number;
  now?: () => number;
  sweepIntervalMs?: number;
}

interface WebConversation {
  readonly agent: WebConversationAgent;
  readonly credentials: { accessToken: string };
  readonly sessionId: string | null;
  closed: boolean;
  lastActivityAt: number;
  pendingTurns: number;
  queue: Promise<void>;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
/*
 * El turno en curso más uno en espera. La interfaz ya bloquea el doble
 * envío; esto solo protege la memoria del proceso frente a otros clientes.
 */
const DEFAULT_MAX_PENDING_TURNS = 2;

/*
 * Una conversación en memoria por usuario autenticado, ligada al inicio de
 * sesión que la abrió. Cada conversación tiene su propia instancia del
 * agente, y por tanto su historial, candidatos, selección y paginación, y
 * una cola que ejecuta sus turnos de uno en uno.
 */
export class WebSessionManager {
  private readonly conversations = new Map<string, WebConversation>();
  private readonly openings = new Map<string, number>();
  private readonly idleTimeoutMs: number;
  private readonly maxPendingTurns: number;
  private readonly now: () => number;
  private readonly sweepIntervalMs: number;
  private openingSequence = 0;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly factory: WebAgentFactory,
    options: WebSessionManagerOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxPendingTurns = options.maxPendingTurns ?? DEFAULT_MAX_PENDING_TURNS;
    this.now = options.now ?? Date.now;
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  get size(): number {
    return this.conversations.size;
  }

  /*
   * Iniciar sesión siempre empieza una conversación limpia: la anterior del
   * mismo usuario se descarta para que un recargo de la página no herede
   * referencias que ya no se ven en pantalla.
   */
  async open(
    identity: WebIdentity,
    accessToken: string,
  ): Promise<WebSessionOpenResult> {
    const { userId } = identity;
    this.discard(userId);
    const sequence = ++this.openingSequence;
    this.openings.set(userId, sequence);

    const credentials = { accessToken };
    let creation;
    try {
      creation = await this.factory.createConversation(
        () => credentials.accessToken,
      );
    } catch {
      creation = { status: "unavailable" } as const;
    }

    if (this.openings.get(userId) !== sequence) {
      return "superseded";
    }
    this.openings.delete(userId);
    if (creation.status !== "ready") {
      return creation.status;
    }

    this.conversations.set(userId, {
      agent: creation.agent,
      credentials,
      sessionId: identity.sessionId,
      closed: false,
      lastActivityAt: this.now(),
      pendingTurns: 0,
      queue: Promise.resolve(),
    });
    return "ready";
  }

  async send(
    identity: WebIdentity,
    accessToken: string,
    message: string,
  ): Promise<WebTurnResult> {
    const conversation = this.conversations.get(identity.userId);
    if (
      conversation === undefined ||
      conversation.sessionId !== identity.sessionId
    ) {
      return { status: "no_session" };
    }
    if (conversation.pendingTurns >= this.maxPendingTurns) {
      return { status: "busy" };
    }

    conversation.credentials.accessToken = accessToken;
    conversation.pendingTurns += 1;
    conversation.lastActivityAt = this.now();

    const turn = conversation.queue.then(() =>
      this.runTurn(conversation, message),
    );
    conversation.queue = turn.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await turn;
    } finally {
      conversation.pendingTurns -= 1;
      conversation.lastActivityAt = this.now();
    }
  }

  /*
   * Cierra la conversación del inicio de sesión indicado y descarta su
   * memoria. Un turno que siga en curso termina sobre un agente huérfano y
   * su respuesta ya no se entrega.
   */
  close(identity: WebIdentity): boolean {
    const conversation = this.conversations.get(identity.userId);
    if (conversation?.sessionId !== identity.sessionId) {
      return false;
    }
    this.openings.delete(identity.userId);
    return this.discard(identity.userId);
  }

  sweep(): void {
    const now = this.now();
    for (const [userId, conversation] of this.conversations) {
      if (
        conversation.pendingTurns === 0 &&
        now - conversation.lastActivityAt >= this.idleTimeoutMs
      ) {
        this.discard(userId);
      }
    }
  }

  start(): void {
    if (this.sweepTimer !== null) {
      return;
    }
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.openings.clear();
    for (const userId of [...this.conversations.keys()]) {
      this.discard(userId);
    }
  }

  private async runTurn(
    conversation: WebConversation,
    message: string,
  ): Promise<WebTurnResult> {
    if (conversation.closed) {
      return { status: "closed" };
    }
    let reply: { status: ChatTurnStatus; text: string };
    try {
      reply = await conversation.agent.respond(message);
    } catch {
      return conversation.closed ? { status: "closed" } : { status: "failed" };
    }
    if (conversation.closed) {
      return { status: "closed" };
    }
    return { status: "ok", reply: { status: reply.status, text: reply.text } };
  }

  private discard(userId: string): boolean {
    const conversation = this.conversations.get(userId);
    if (conversation === undefined) {
      return false;
    }
    conversation.closed = true;
    this.conversations.delete(userId);
    return true;
  }
}
