import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { BrandSymbol } from "./BrandSymbol";
import { AlertIcon, LockIcon } from "./Icons";

interface AccessModalProps {
  notice: string | null;
  /*
   * Devuelve el mensaje que debe verse si el acceso no se completó, o null
   * cuando la sesión quedó abierta.
   */
  onSubmit(email: string, password: string): Promise<string | null>;
}

const MISSING_CREDENTIALS = "Escribe tu correo electrónico y tu contraseña.";
const UNEXPECTED_FAILURE = "No fue posible iniciar sesión. Intenta de nuevo.";

export function AccessModal({ notice, onSubmit }: AccessModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const emailId = `${id}-email`;
  const passwordId = `${id}-password`;
  const messageId = `${id}-message`;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(notice);
  const submittingRef = useRef(false);
  const mountedRef = useRef(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    emailRef.current?.focus();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) {
      return;
    }

    const normalizedEmail = email.trim();
    if (normalizedEmail === "" || password === "") {
      setError(MISSING_CREDENTIALS);
      (normalizedEmail === "" ? emailRef : passwordRef).current?.focus();
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);

    let failure: string | null;
    try {
      failure = await onSubmit(normalizedEmail, password);
    } catch {
      failure = UNEXPECTED_FAILURE;
    }

    submittingRef.current = false;
    if (!mountedRef.current) {
      return;
    }
    // La contraseña no se conserva después de cada intento.
    setPassword("");
    setPasswordVisible(false);
    setSubmitting(false);
    setError(failure);
    if (failure !== null) {
      passwordRef.current?.focus();
    }
  }

  return (
    <div className="access-veil">
      <section
        className="access-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="brand brand--modal">
          <BrandSymbol className="brand__symbol" />
          <span className="brand__word">SIBIA</span>
        </div>
        <h1 id={titleId} className="access-modal__title">
          Acceso seguro
        </h1>

        <form
          className="access-form"
          onSubmit={(event) => void handleSubmit(event)}
          noValidate
        >
          <div className="access-form__fields">
            <div className="field">
              <label className="field__label" htmlFor={emailId}>
                Correo electrónico
              </label>
              <div className="field__control">
                <input
                  ref={emailRef}
                  id={emailId}
                  className="field__input"
                  type="email"
                  name="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  inputMode="email"
                  spellCheck={false}
                  placeholder="tucorreo@empresa.com"
                  value={email}
                  readOnly={submitting}
                  aria-describedby={messageId}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor={passwordId}>
                Contraseña
              </label>
              <div className="field__control">
                <input
                  ref={passwordRef}
                  id={passwordId}
                  className="field__input field__input--password"
                  type={passwordVisible ? "text" : "password"}
                  name="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={password}
                  readOnly={submitting}
                  aria-describedby={messageId}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <button
                  type="button"
                  className="field__toggle"
                  aria-controls={passwordId}
                  aria-pressed={passwordVisible}
                  aria-label={
                    passwordVisible ? "Ocultar contraseña" : "Mostrar contraseña"
                  }
                  onClick={() => setPasswordVisible((visible) => !visible)}
                >
                  {passwordVisible ? "Ocultar" : "Mostrar"}
                </button>
              </div>
            </div>
          </div>

          <button
            type="submit"
            className="button-primary"
            disabled={submitting}
            aria-busy={submitting}
          >
            {submitting ? "Validando acceso…" : "Ingresar a SIBIA"}
          </button>
        </form>

        <div id={messageId} className="access-message">
          {error === null ? (
            <p className="access-message__help">
              <LockIcon className="access-message__icon" />
              Tus credenciales se validan de forma segura.
            </p>
          ) : (
            <p className="access-message__error" role="alert">
              <AlertIcon className="access-message__icon" />
              {error}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
