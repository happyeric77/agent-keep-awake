import { getOpenCodeStatus } from "./opencode.mjs";
const count = getOpenCodeStatus().activeSessions.length;
if (count) process.stdout.write(`🖥️ OpenCode sessions: ${count} active\n`);
