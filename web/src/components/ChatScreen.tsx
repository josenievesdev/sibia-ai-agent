import { useEffect, useRef, useState } from "react";

import { ApiError, type SibiaApi } from "../lib/api-client";
import { ChatTurn, type ChatMessage } from "./ChatTurn";
import { Composer } from "./Composer";
import { ConsultingIndicator } from "./ConsultingIndicator";
import { AlertIcon } from "./Icons";
import { Welcome } from "./Welcome";

interface ChatScreenProps {
  api: SibiaApi;
  greeting: string;
  getAccessToken(): Promise<string | null>;
  onSessionExpired(): void;
}

/*
 * Distancia al final dentro de la cual se considera que el usuario sigue
 * la conversación. Si se desplazó más arriba para leer, las respuestas
 * nuevas no mueven la vista.
 */
const FOLLOW_DISTANCE = 96;
const REQUEST_FAILED = "No fue posible obtener la respuesta de SIBIA. Intenta de nuevo.";

function scrollBehavior(): ScrollBehavior {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

export function ChatScreen({
  api,
  greeting,
  getAccessToken,
  onSessionExpired,
}: ChatScreenProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const nextIdRef = useRef(1);
  const followRef = useRef(true);
  const wasPendingRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const latestQuestionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // Al cerrar sesión la pantalla se desmonta y la consulta en curso se cancela.
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const last = messages.at(-1);
    const thread = threadRef.current;
    if (last === undefined || thread === null) {
      return;
    }
    if (last.role === "user") {
      followRef.current = true;
      thread.scrollTo({ top: thread.scrollHeight, behavior: scrollBehavior() });
    } else if (followRef.current) {
      // La pregunta queda arriba y la respuesta se lee desde su comienzo.
      latestQuestionRef.current?.scrollIntoView({
        behavior: scrollBehavior(),
        block: "start",
      });
    }
  }, [messages]);

  useEffect(() => {
    const thread = threadRef.current;
    if (error !== null && thread !== null && followRef.current) {
      thread.scrollTo({ top: thread.scrollHeight, behavior: scrollBehavior() });
    }
  }, [error]);

  useEffect(() => {
    if (wasPendingRef.current && !pending) {
      inputRef.current?.focus({ preventScroll: true });
    }
    wasPendingRef.current = pending;
  }, [pending]);

  function handleScroll() {
    const thread = threadRef.current;
    if (thread !== null) {
      followRef.current =
        thread.scrollHeight - thread.scrollTop - thread.clientHeight <= FOLLOW_DISTANCE;
    }
  }

  async function send() {
    const message = draft;
    if (message.trim() === "" || pendingRef.current) {
      return;
    }

    pendingRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const questionId = nextIdRef.current++;
    setMessages((current) => [...current, { id: questionId, role: "user", text: message }]);
    setDraft("");
    setError(null);
    setPending(true);

    try {
      const accessToken = await getAccessToken();
      if (controller.signal.aborted) {
        return;
      }
      if (accessToken === null) {
        onSessionExpired();
        return;
      }

      const reply = await api.sendMessage(accessToken, message, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      const replyId = nextIdRef.current++;
      setMessages((current) => [
        ...current,
        { id: replyId, role: "assistant", text: reply.text },
      ]);
    } catch (caught) {
      if (controller.signal.aborted) {
        return;
      }
      if (caught instanceof ApiError && caught.kind === "unauthorized") {
        onSessionExpired();
        return;
      }
      setError(
        caught instanceof ApiError && caught.kind === "busy"
          ? caught.message
          : REQUEST_FAILED,
      );
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  const empty = messages.length === 0;
  const latestQuestionIndex = messages.findLastIndex((message) => message.role === "user");

  return (
    <main className={empty ? "stage stage--empty" : "stage"}>
      <div ref={threadRef} className="thread" onScroll={handleScroll}>
        {empty ? (
          <Welcome greeting={greeting} />
        ) : (
          <div className="thread__inner">
            <h1 className="visually-hidden">Conversación con SIBIA</h1>
            {messages.map((message, index) => (
              <ChatTurn
                key={message.id}
                message={message}
                ref={index === latestQuestionIndex ? latestQuestionRef : undefined}
              />
            ))}
            {pending && <ConsultingIndicator />}
            {error !== null && (
              <p className="thread__error" role="alert">
                <AlertIcon className="thread__error-icon" />
                {error}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="composer-zone">
        <Composer
          value={draft}
          busy={pending}
          inputRef={inputRef}
          onChange={setDraft}
          onSubmit={() => void send()}
        />
      </div>
    </main>
  );
}
