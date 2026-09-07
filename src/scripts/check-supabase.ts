import { ConfigurationError, loadConfig } from "../config/env.js";
import type {
  IntegrationCheckResult,
  IntegrationStatus,
} from "../integrations/check-result.js";
import { checkSupabaseSchema } from "../integrations/supabase/check.js";

const exitCodes: Record<IntegrationStatus, number> = {
  available: 0,
  access_unverified: 6,
  authentication_failed: 4,
  configuration_error: 2,
  not_configured: 2,
  permission_denied: 5,
  schema_missing: 3,
  unavailable: 1,
};

let result: IntegrationCheckResult;

try {
  result = await checkSupabaseSchema(loadConfig());
} catch (error) {
  if (!(error instanceof ConfigurationError)) {
    throw error;
  }

  result = {
    integration: "supabase",
    status: "configuration_error",
    code: "SUPABASE_CONFIGURATION_ERROR",
    message: error.message,
    checkedAt: new Date().toISOString(),
    durationMs: 0,
    metadata: {},
  };
}

console.log(JSON.stringify(result, null, 2));
process.exitCode = exitCodes[result.status];
