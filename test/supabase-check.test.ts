import assert from "node:assert/strict";
import test from "node:test";

import { classifySupabaseQueryError } from "../src/integrations/supabase/check.js";

test("classifies a missing table separately from connectivity", () => {
  assert.deepEqual(
    classifySupabaseQueryError({
      code: "PGRST205",
      message: "Could not find the table in the schema cache",
    }),
    {
      status: "schema_missing",
      code: "SUPABASE_TABLE_MISSING",
      message:
        "Supabase respondió y aceptó la solicitud, pero public.roles todavía no existe.",
    },
  );
});

test("classifies authentication failures", () => {
  assert.equal(
    classifySupabaseQueryError({
      code: "PGRST301",
      message: "Invalid JWT",
    }).status,
    "authentication_failed",
  );
});

test("classifies permission failures", () => {
  assert.equal(
    classifySupabaseQueryError({
      code: "42501",
      message: "permission denied for table roles",
    }).status,
    "permission_denied",
  );
});
