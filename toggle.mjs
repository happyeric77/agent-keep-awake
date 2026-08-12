import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  daemonAlive,
  loadDotEnv,
  modeEnabled,
  modePath,
  pluginRoot,
  readDaemonPid,
  setMode,
} from "./lib.mjs";

loadDotEnv();

const requested = process.argv[2]?.trim().toLowerCase();
const enabled =
  requested === "on" || requested === "enable" || requested === "enabled"
    ? true
    : requested === "off" || requested === "disable" || requested === "disabled"
      ? false
      : !modeEnabled();

setMode(enabled);
const label = enabled ? "enabled" : "disabled";
console.log(`Keep awake ${label}.`);
console.log(`State: ${modePath()}`);

if (enabled) {
  if (!daemonAlive()) {
    const child = spawn(process.execPath, [join(pluginRoot, "daemon.mjs")], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    console.log(`Keep-awake daemon started (pid ${child.pid}).`);
  }
} else if (daemonAlive()) {
  const pid = readDaemonPid();
  const kill = spawnSync("kill", ["-TERM", String(pid)], { encoding: "utf8" });
  if (kill.status !== 0) {
    console.error(
      `Failed to stop daemon (${kill.status}): ${kill.stderr ?? "unknown error"}`.trim(),
    );
  }
}

const herdrBin = process.env.HERDR_BIN_PATH ?? "herdr";
const notice = spawnSync(
  herdrBin,
  ["notification", "show", "Keep awake", "--body", `Keep awake ${label}`],
  { encoding: "utf8" },
);
if (notice.status !== 0) {
  console.error(
    `notification show failed (${notice.status}): ${notice.stderr ?? notice.stdout ?? "unknown error"}`.trim(),
  );
}
