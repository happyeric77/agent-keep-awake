import { getOpenCodeStatus } from "./opencode.mjs";

const { activeSessions, activeShells } = getOpenCodeStatus();
const sessions = activeSessions.length;
const shells = activeShells.length;
if (sessions) {
  const sessionLabel = sessions === 1 ? "session" : "sessions";
  const shellLabel = shells === 1 ? "shell" : "shells";
  process.stdout.write(`🖥️ ${sessions} ${sessionLabel} · ${shells} ${shellLabel}\n`);
}
