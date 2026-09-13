import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { createApiClient } from "./lib/api-client";
import { createSupabaseAuth } from "./lib/auth";
import "./styles/index.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("No existe el contenedor #root.");
}

const api = createApiClient();
const auth = createSupabaseAuth(api);

createRoot(root).render(
  <StrictMode>
    <App api={api} auth={auth} />
  </StrictMode>,
);
