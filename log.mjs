import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv, stateDir } from "./lib.mjs";

export function appendLog(line) {
  try {
    appendFileSync(join(stateDir(), "daemon.log"), `${line}\n`, "utf8");
  } catch {
    // ignore
  }
}
