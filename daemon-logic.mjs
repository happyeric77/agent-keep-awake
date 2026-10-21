export function anyAgentWorking(panes) {
  if (!Array.isArray(panes)) return false;
  return panes.some((pane) => pane?.agent_status === "working");
}
