import { spawn } from "node:child_process";
import { join } from "node:path";
import { daemonAlive, loadDotEnv, modeEnabled, pluginRoot } from "./lib.mjs";

loadDotEnv();

if (!modeEnabled()) {
  console.log("Keep awake disabled. Enable it with: herdr plugin action invoke herdr.keep-awake.toggle");
  process.exit(0);
}

if (daemonAlive()) {
  console.log("Keep-awake daemon already running.");
  process.exit(0);
}

const child = spawn(process.execPath, [join(pluginRoot, "daemon.mjs")], {
  detached: true,
  stdio: "ignore",
});
child.unref();
console.log(`Keep-awake daemon started (pid ${child.pid}).`);
process.exit(0);
