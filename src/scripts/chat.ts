import type { SupabaseClient } from "@supabase/supabase-js";

import { StoreChatAgent } from "../agent/store-chat-agent.js";
import { runInteractiveChat } from "../console/interactive-chat.js";
import { ConsoleInputError } from "../console/interactive-input.js";
import {
  InteractiveSessionError,
  withInteractiveSupabaseSession,
} from "../console/interactive-supabase-session.js";
import type { AppConfig } from "../config/env.js";
import { OllamaChatClient } from "../integrations/ollama/chat-client.js";
import { checkActiveAdminAccess } from "../integrations/supabase/admin-access.js";
import { SupabaseStoreGateway } from "../store/supabase-store-gateway.js";
import { StoreReadToolCatalog } from "../tools/store-read-tool-catalog.js";
import { StoreReadTools } from "../tools/store-read-tools.js";

async function startChat(
  client: SupabaseClient,
  config: AppConfig,
): Promise<void> {
  const access = await checkActiveAdminAccess(
    client,
    config.integrationCheckTimeoutMs,
  );
  if (access.status !== "authorized") {
    console.log(`SIBIA: ${access.message}`);
    process.exitCode = access.status === "forbidden" ? 4 : 5;
    return;
  }

  const debug = config.ollama.debug || process.argv.includes("--debug");
  const ollama = new OllamaChatClient({ ...config.ollama, debug });
  const tools = new StoreReadTools(new SupabaseStoreGateway(client));
  const catalog = new StoreReadToolCatalog(tools);
  const agent = new StoreChatAgent(ollama, catalog);
  await runInteractiveChat(agent);
}

try {
  await withInteractiveSupabaseSession(startChat);
} catch (error) {
  if (error instanceof InteractiveSessionError) {
    console.error(`SIBIA: ${error.message}`);
    process.exitCode ||= error.exitCode;
  } else if (error instanceof ConsoleInputError) {
    console.error(`SIBIA: ${error.message}`);
    process.exitCode ||= 2;
  } else {
    console.error("SIBIA: No fue posible iniciar el chat.");
    process.exitCode ||= 1;
  }
}
