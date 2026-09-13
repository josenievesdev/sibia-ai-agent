import { useCallback, useRef, useState } from "react";

import { AccessModal } from "./components/AccessModal";
import { AppHeader } from "./components/AppHeader";
import { ChatScreen } from "./components/ChatScreen";
import { Composer } from "./components/Composer";
import { Welcome } from "./components/Welcome";
import { ApiError, type SibiaApi } from "./lib/api-client";
import type { AuthService } from "./lib/auth";
import { pickWelcomeGreeting, WELCOME_GREETINGS } from "./lib/welcome";

export interface AppProps {
  api: SibiaApi;
  auth: AuthService;
}

type AppSession =
  | { status: "signed_out"; notice: string | null }
  | { status: "signed_in"; greeting: string; key: number };

const INVALID_CREDENTIALS = "Correo o contraseña incorrectos.";
const AUTH_UNAVAILABLE =
  "No fue posible validar tus credenciales en este momento. Intenta de nuevo.";
const ADMIN_ACCESS_REQUIRED = "Tu cuenta no tiene acceso administrativo activo en SIBIA.";
const SESSION_START_FAILED = "No fue posible iniciar tu sesión en SIBIA. Intenta de nuevo.";
const SESSION_EXPIRED = "Tu sesión terminó. Vuelve a iniciar sesión.";

function ignore() {}

export function App({ api, auth }: AppProps) {
  const [session, setSession] = useState<AppSession>({
    status: "signed_out",
    notice: null,
  });
  const sessionCountRef = useRef(0);

  const signIn = useCallback(
    async (email: string, password: string): Promise<string | null> => {
      const result = await auth.signIn(email, password);
      if (result.status === "invalid_credentials") {
        return INVALID_CREDENTIALS;
      }
      if (result.status === "unavailable") {
        return AUTH_UNAVAILABLE;
      }

      try {
        await api.startSession(result.accessToken);
      } catch (error) {
        await auth.signOut();
        return error instanceof ApiError && error.kind === "forbidden"
          ? ADMIN_ACCESS_REQUIRED
          : SESSION_START_FAILED;
      }

      sessionCountRef.current += 1;
      setSession({
        status: "signed_in",
        greeting: pickWelcomeGreeting(),
        key: sessionCountRef.current,
      });
      return null;
    },
    [api, auth],
  );

  const signOut = useCallback(async () => {
    const accessToken = await auth.getAccessToken();
    setSession({ status: "signed_out", notice: null });
    if (accessToken !== null) {
      await api.endSession(accessToken).catch(ignore);
    }
    await auth.signOut();
  }, [api, auth]);

  const expireSession = useCallback(() => {
    setSession({ status: "signed_out", notice: SESSION_EXPIRED });
    void auth.signOut();
  }, [auth]);

  const getAccessToken = useCallback(() => auth.getAccessToken(), [auth]);
  const signedIn = session.status === "signed_in";

  return (
    <>
      <div className="app" inert={!signedIn} aria-hidden={signedIn ? undefined : true}>
        <AppHeader onSignOut={signedIn ? () => void signOut() : ignore} />
        {session.status === "signed_in" ? (
          <ChatScreen
            key={session.key}
            api={api}
            greeting={session.greeting}
            getAccessToken={getAccessToken}
            onSessionExpired={expireSession}
          />
        ) : (
          <main className="stage stage--empty">
            <div className="thread">
              <Welcome greeting={WELCOME_GREETINGS[0]} />
            </div>
            <div className="composer-zone">
              <Composer value="" busy={false} onChange={ignore} onSubmit={ignore} />
            </div>
          </main>
        )}
      </div>
      {session.status === "signed_out" && (
        <AccessModal notice={session.notice} onSubmit={signIn} />
      )}
    </>
  );
}
