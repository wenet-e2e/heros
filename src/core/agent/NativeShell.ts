import { NativeModules, Platform } from "react-native";

type NativeShellModule = {
  exec(command: string, timeoutMs?: number): Promise<{
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }>;
};

const NativeShell = (NativeModules as { NativeShell?: NativeShellModule }).NativeShell;

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /mkfs/,
  /shutdown/,
  /reboot/,
  /:\(\)\s*\{\s*:\|\:&\s*\};:/,
  /\bdd\s+if=/,
  /sudo\s+/,
  /\bcurl\b.*\|\s*(bash|sh)/,
  /\bwget\b.*\|\s*(bash|sh)/,
];

function commandIsSafe(command: string): boolean {
  const lowered = command.toLowerCase();
  return !BLOCKED_PATTERNS.some((pattern) => pattern.test(lowered));
}

export async function runSystemExec(
  command: string,
  timeoutSec = 10
): Promise<{ ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string }> {
  const cleanCommand = command.trim();
  if (!cleanCommand) {
    return { ok: false, error: "command is required" };
  }
  if (!commandIsSafe(cleanCommand)) {
    return { ok: false, error: "command blocked by policy" };
  }
  if (Platform.OS !== "macos") {
    return { ok: false, error: `system_exec is unsupported on ${Platform.OS}` };
  }
  if (!NativeShell || typeof NativeShell.exec !== "function") {
    return { ok: false, error: "NativeShell module is unavailable" };
  }

  const safeTimeoutSec = Math.max(1, Math.min(30, Number(timeoutSec) || 10));
  try {
    const result = await NativeShell.exec(cleanCommand, safeTimeoutSec * 1000);
    return {
      ok: true,
      exitCode: Number(result?.exitCode ?? 1),
      stdout: String(result?.stdout || "").slice(0, 4000),
      stderr: String(result?.stderr || "").slice(0, 4000),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: true, exitCode: 1, stdout: "", stderr: message };
  }
}
