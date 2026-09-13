import type { Ref } from "react";

import { AssistantMarkdown } from "./AssistantMarkdown";

export interface ChatMessage {
  id: number;
  role: "assistant" | "user";
  text: string;
}

interface ChatTurnProps {
  message: ChatMessage;
  ref?: Ref<HTMLElement> | undefined;
}

export function ChatTurn({ message, ref }: ChatTurnProps) {
  if (message.role === "user") {
    return (
      <article ref={ref} className="turn turn--user" aria-label="Tu mensaje">
        <p className="turn__bubble">{message.text}</p>
      </article>
    );
  }

  return (
    <article ref={ref} className="turn turn--assistant" aria-label="Respuesta de SIBIA">
      <p className="turn__author" aria-hidden="true">
        SIBIA
      </p>
      <AssistantMarkdown text={message.text} />
    </article>
  );
}
