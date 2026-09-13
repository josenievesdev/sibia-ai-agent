import {
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { ArrowUpIcon } from "./Icons";

/*
 * Mismo límite que aplica el agente a cada mensaje del usuario.
 */
const MAX_MESSAGE_CHARACTERS = 2_000;
const MAX_INPUT_HEIGHT = 180;

interface ComposerProps {
  value: string;
  busy: boolean;
  onChange(value: string): void;
  onSubmit(): void;
  inputRef?: RefObject<HTMLTextAreaElement | null> | undefined;
}

export function Composer({ value, busy, onChange, onSubmit, inputRef }: ComposerProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const localRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? localRef;
  const canSend = value.trim() !== "" && !busy;

  useLayoutEffect(() => {
    const input = ref.current;
    if (input === null) {
      return;
    }
    input.style.height = "auto";
    if (input.scrollHeight > 0) {
      input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`;
    }
  }, [value, ref]);

  function submit() {
    if (canSend) {
      onSubmit();
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={id} className="visually-hidden">
        Escribe tu pregunta para SIBIA
      </label>
      <span id={hintId} className="visually-hidden">
        Enter envía la pregunta y Shift más Enter agrega una línea.
      </span>
      <textarea
        ref={ref}
        id={id}
        className="composer__input"
        rows={1}
        value={value}
        placeholder="Escribe tu pregunta…"
        maxLength={MAX_MESSAGE_CHARACTERS}
        enterKeyHint="send"
        autoComplete="off"
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button
        type="submit"
        className="composer__send"
        disabled={!canSend}
        aria-label="Enviar pregunta"
      >
        <ArrowUpIcon className="composer__send-icon" />
      </button>
    </form>
  );
}
