import { loadConfig } from "../config/env.js";
import { checkOllamaModel } from "../integrations/ollama-check.js";

const result = await checkOllamaModel(loadConfig());
console.log(JSON.stringify(result, null, 2));

if (result.status !== "available") {
  process.exitCode = 1;
}
