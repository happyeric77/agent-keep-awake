import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { pluginRoot } from "./lib.mjs";

const MAX_FILE_SIZE = 65_536;

export function getOpenCodeStateDir() {
  if (process.env.OPENCODE_STATE_DIR) {
    return process.env.OPENCODE_STATE_DIR;
  }
  const stateHome =
    process.env.XDG_STATE_HOME ||
    (process.env.HOME ? join(process.env.HOME, ".local", "state") : pluginRoot);
  return join(stateHome, "herdr-keep-awake", "opencode");
}

function defaultIsPidAlive(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseHeartbeatTimeout(val) {
  const parsed = typeof val === "number" ? val : parseInt(val ?? "30", 10) * 1000;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

export function getOpenCodeStatus(options = {}) {
  const opencodeDir = options.opencodeDir ?? getOpenCodeStateDir();
  const heartbeatTimeoutMs = parseHeartbeatTimeout(
    options.heartbeatTimeoutMs ?? process.env.OPENCODE_HEARTBEAT_TIMEOUT,
  );
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

  const emptyResult = {
    working: false,
    instancesCount: 0,
    totalSessionsCount: 0,
    activeSessions: [],
  };

  if (!existsSync(opencodeDir)) {
    return emptyResult;
  }

  let entries;
  try {
    entries = readdirSync(opencodeDir, { withFileTypes: true });
  } catch {
    return emptyResult;
  }

  const now = Date.now();
  const activeSessions = [];
  let instancesCount = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const filePath = join(opencodeDir, entry.name);

    let fd;
    try {
      fd = openSync(filePath, "r");
    } catch {
      continue;
    }

    let state;
    try {
      const stat = fstatSync(fd);
      if (stat.size <= 0 || stat.size > MAX_FILE_SIZE) {
        continue;
      }
      const buf = Buffer.alloc(MAX_FILE_SIZE + 1);
      const bytesRead = readSync(fd, buf, 0, MAX_FILE_SIZE + 1, 0);
      if (bytesRead <= 0 || bytesRead > MAX_FILE_SIZE) {
        continue;
      }
      const raw = buf.toString("utf8", 0, bytesRead);
      state = JSON.parse(raw);
    } catch {
      continue;
    } finally {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }

    if (
      !state ||
      typeof state !== "object" ||
      typeof state.pid !== "number" ||
      !Number.isInteger(state.pid) ||
      state.pid <= 0 ||
      typeof state.heartbeat !== "number" ||
      !Number.isFinite(state.heartbeat) ||
      typeof state.sessions !== "object" ||
      state.sessions === null ||
      Array.isArray(state.sessions)
    ) {
      continue;
    }

    // Reject future heartbeat (tolerance 5s)
    if (state.heartbeat > now + 5000) {
      continue;
    }

    // Reject stale heartbeat
    if (now - state.heartbeat > heartbeatTimeoutMs) {
      continue;
    }

    // Check process liveness; do not unlink dead PID to prevent race with replacement file
    if (!isPidAlive(state.pid)) {
      continue;
    }

    instancesCount += 1;
    for (const [sessionID, info] of Object.entries(state.sessions)) {
      const status = info?.status ?? info?.type;
      if (status === "running") {
        activeSessions.push(sessionID);
      }
    }
  }

  const working = activeSessions.length > 0;

  return {
    working,
    instancesCount,
    totalSessionsCount: activeSessions.length,
    activeSessions,
  };
}
