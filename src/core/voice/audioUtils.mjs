/**
 * SoX audio utilities (Node.js CLI only).
 * Used by doubao_cli.mjs and test_pipeline.mjs for audio I/O.
 */

import { spawn } from "node:child_process";

export const OUTPUT_SAMPLE_RATE = 24000;
export const INPUT_SAMPLE_RATE = 16000;
export const INPUT_CHUNK_FRAMES = 3200; // 200ms @ 16kHz

let _soxAvailable = null;
export function isSoxAvailable() {
  if (_soxAvailable !== null) return _soxAvailable;
  try {
    const result = spawn("play", ["--version"], { stdio: "pipe", timeout: 3000 });
    _soxAvailable = true;
    result.kill();
  } catch {
    _soxAvailable = false;
  }
  return _soxAvailable;
}

export function createAudioPlayer() {
  if (!isSoxAvailable()) {
    return null;
  }
  const player = spawn("sox", [
    "-q",
    "-t", "raw", "-r", String(OUTPUT_SAMPLE_RATE),
    "-e", "signed-integer", "-b", "16", "-c", "1", "-",
    "-d",
  ], { stdio: ["pipe", "ignore", "ignore"] });

  player.on("error", () => { /* ignore */ });
  player.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.log(`[audio] sox 播放进程退出 code=${code}`);
    }
  });
  return player;
}

export function writeToPlayer(player, pcmData) {
  if (!player || player.killed) return false;
  try {
    const buf = Buffer.from(pcmData.buffer, pcmData.byteOffset, pcmData.byteLength);
    player.stdin.write(buf);
    return true;
  } catch {
    return false;
  }
}

export function stopPlayer(player) {
  if (!player || player.killed) return;
  try {
    player.stdin.end();
    setTimeout(() => { try { player.kill(); } catch { /* ignore */ } }, 500);
  } catch { /* ignore */ }
}

export function createAudioRecorder() {
  if (!isSoxAvailable()) {
    return null;
  }
  const recorder = spawn("rec", [
    "-t", "raw", "-r", String(INPUT_SAMPLE_RATE),
    "-e", "signed", "-b", "16", "-c", "1", "-",
  ], { stdio: ["ignore", "pipe", "ignore"] });

  recorder.on("error", () => { /* ignore */ });
  return recorder;
}

export function stopRecorder(recorder) {
  if (!recorder || recorder.killed) return;
  try {
    recorder.kill("SIGTERM");
    setTimeout(() => { try { recorder.kill(); } catch { /* ignore */ } }, 500);
  } catch { /* ignore */ }
}
