import { spawnSync } from "node:child_process";

const PROCESS_TABLE_TIMEOUT_MS = 1_000;
const PROCESS_TABLE_MAX_BYTES = 4 * 1024 * 1024;
const PS_PATH = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";

export function processGroupIsRunning(groupId, {
  signal = process.kill,
  readProcessTable = readPosixProcessTable,
} = {}) {
  if (!groupExists(groupId, signal)) return false;
  const state = classifyProcessGroup(readProcessTable(), groupId);
  if (state === "zombie-only") return false;
  if (state === "running") return true;
  // The table lists no member, or could not be read. A zombie answers signal 0 until its parent reaps it, and the reap
  // can land between the signal and the ps read, so ask again: a group that is gone now was gone, not hiding.
  return groupExists(groupId, signal);
}

function groupExists(groupId, signal) {
  try {
    signal(-groupId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

export function classifyProcessGroup(processTable, groupId) {
  if (typeof processTable !== "string") return "unknown";

  let found = false;
  for (const line of processTable.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\S+)/u.exec(line);
    if (!match || Number.parseInt(match[1], 10) !== groupId) continue;
    found = true;
    if (!match[2].startsWith("Z")) return "running";
  }
  return found ? "zombie-only" : "unknown";
}

function readPosixProcessTable() {
  const result = spawnSync(PS_PATH, ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    maxBuffer: PROCESS_TABLE_MAX_BYTES,
    timeout: PROCESS_TABLE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}
