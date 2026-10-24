import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRoot } from "./lib.mjs";

const MAX_FILE_SIZE = 65_536;

export function getOpenCodeStateDir() {
  if (process.env.OPENCODE_STATE_DIR) return process.env.OPENCODE_STATE_DIR;
  const stateHome =
    process.env.XDG_STATE_HOME ?? (process.env.HOME ? join(process.env.HOME, ".local", "state") : pluginRoot);
  return join(stateHome, "herdr-keep-awake", "opencode");
}

function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getOpenCodeStatus(options = {}) {
  const opencodeDir = options.opencodeDir ?? getOpenCodeStateDir();
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const activeSessions = new Set();
  let instancesCount = 0;

  let entries = [];
  try {
    entries = readdirSync(opencodeDir);
  } catch {
    // No snapshot yet.
  }

  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    let snapshot;
    try {
      const raw = readFileSync(join(opencodeDir, name), "utf8");
      if (raw.length > MAX_FILE_SIZE) continue;
      snapshot = JSON.parse(raw);
    } catch {
      continue;
    }
    // A dead writer leaves stale snapshots behind. Ignore them without deleting
    // so a concurrently replaced file is never unlinked.
    if (!Array.isArray(snapshot?.sessions) || !isPidAlive(snapshot.pid)) continue;
    instancesCount += 1;
    for (const sessionID of snapshot.sessions) {
      if (typeof sessionID === "string") activeSessions.add(sessionID);
    }
  }

  return {
    working: activeSessions.size > 0,
    instancesCount,
    activeSessions: [...activeSessions],
  };
}
