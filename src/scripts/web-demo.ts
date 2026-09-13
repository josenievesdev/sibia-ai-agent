import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/*
 * Demostración local: levanta la API de Fastify y la interfaz web de Vite.
 * La API lee .env por sí misma; el proceso de Vite no recibe esas variables.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));
const viteCli = fileURLToPath(new URL("../../node_modules/vite/bin/vite.js", import.meta.url));

const children: ChildProcess[] = [];
let stopping = false;

function stop(exitCode: number): void {
  if (stopping) {
    return;
  }
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
    }
  }
}

function run(name: string, args: string[]): void {
  const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit" });
  child.on("exit", (code) => {
    if (!stopping) {
      console.error(`SIBIA demo: ${name} se detuvo.`);
      stop(code ?? 1);
    }
  });
  children.push(child);
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run("la API", ["--env-file-if-exists=.env", "--import", "tsx", "src/http/server.ts"]);
run("la interfaz web", [viteCli, "--config", "web/vite.config.ts"]);

console.log("SIBIA demo: abre http://127.0.0.1:5173 y usa Ctrl+C para detener.");
