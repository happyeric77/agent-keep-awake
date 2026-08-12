import { spawn } from "node:child_process";

let caffeinateProcess = null;

export function ensureAwake(on) {
  if (on) {
    if (caffeinateProcess && caffeinateProcess.exitCode === null) {
      return;
    }
    caffeinateProcess = spawn("caffeinate", ["-i", "-s", "-w", String(process.pid)], {
      stdio: "ignore",
    });
    caffeinateProcess.on("error", (error) => {
      console.error(`caffeinate spawn failed: ${error.message}`);
      caffeinateProcess = null;
    });
    return;
  }
  if (caffeinateProcess && caffeinateProcess.exitCode === null) {
    try {
      caffeinateProcess.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  caffeinateProcess = null;
}
