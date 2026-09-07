export type IntegrationName = "ollama" | "supabase";
export type IntegrationStatus =
  | "available"
  | "access_unverified"
  | "authentication_failed"
  | "configuration_error"
  | "not_configured"
  | "permission_denied"
  | "schema_missing"
  | "unavailable";

export interface IntegrationCheckResult {
  integration: IntegrationName;
  status: IntegrationStatus;
  code: string;
  message: string;
  checkedAt: string;
  durationMs: number;
  metadata: Record<string, boolean | number | string>;
}
