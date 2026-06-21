import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn('which', [command], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export class PcmRecorder extends EventEmitter {
  constructor({ sampleRate = 16000 } = {}) {
    super();
    this.sampleRate = sampleRate;
    this.child = null;
  }

  async start() {
    if (!(await commandExists('rec'))) {
      throw new Error('Missing `rec`. Install SoX first, for example: brew install sox');
    }
    this.child = spawn('rec', [
      '-q',
      '-b',
      '16',
      '-c',
      '1',
      '-r',
      String(this.sampleRate),
      '-e',
      'signed-integer',
      '-t',
      'raw',
      '-',
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    this.child.stdout.on('data', (chunk) => this.emit('data', chunk));
    this.child.on('close', (code, signal) => this.emit('close', { code, signal }));
  }

  stop() {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGINT');
    }
    this.child = null;
  }
}

export class PcmPlayer {
  constructor({
    sampleRate = 24000,
    enabled = true,
    drainPaddingMs = 180,
    flushSilenceMs = 260,
    bufferBytes = 512,
  } = {}) {
    this.sampleRate = sampleRate;
    this.enabled = enabled;
    this.drainPaddingMs = drainPaddingMs;
    this.flushSilenceMs = flushSilenceMs;
    this.bufferBytes = bufferBytes;
    this.child = null;
    this.available = false;
    this.idleWaiters = [];
    this.idleTimer = null;
    this.playbackCursorUntil = 0;
  }

  async start() {
    if (!this.enabled) {
      return;
    }
    if (!(await commandExists('play'))) {
      this.enabled = false;
      return;
    }
    this.available = true;
  }

  begin() {
    if (!this.enabled || !this.available) {
      return;
    }
    this.ensureChild();
  }

  ensureChild() {
    if (!this.enabled || !this.available) {
      return null;
    }
    if (this.child && !this.child.killed && this.child.stdin?.writable) {
      return this.child;
    }
    const child = spawn('play', [
      '-q',
      '--buffer',
      String(this.bufferBytes),
      '-b',
      '16',
      '-c',
      '1',
      '-r',
      String(this.sampleRate),
      '-e',
      'signed-integer',
      '-t',
      'raw',
      '-',
    ], { stdio: ['pipe', 'ignore', 'inherit'] });
    this.child = child;
    child.stdin.on('error', () => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.playbackCursorUntil = 0;
      this.clearIdleTimer();
      this.resolveIdleWaiters();
    });
    child.once('close', () => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
      this.playbackCursorUntil = 0;
      this.clearIdleTimer();
      this.resolveIdleWaiters();
    });
    return child;
  }

  bytesPerSecond() {
    return this.sampleRate * 2;
  }

  durationMsForBytes(byteLength) {
    return Math.ceil((byteLength / this.bytesPerSecond()) * 1000);
  }

  silenceForMs(durationMs) {
    const byteLength = Math.ceil((durationMs / 1000) * this.bytesPerSecond());
    return Buffer.alloc(byteLength);
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  resolveIdleWaiters() {
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }

  write(chunk) {
    if (!this.enabled || !this.available || !chunk?.length) {
      return;
    }
    const child = this.ensureChild();
    if (!child || child.killed || !child.stdin.writable) {
      return;
    }
    const durationMs = this.durationMsForBytes(chunk.length);
    const now = Date.now();
    this.playbackCursorUntil = Math.max(now, this.playbackCursorUntil) + durationMs;
    this.scheduleIdleResolution();
    try {
      child.stdin.write(chunk);
    } catch {
      this.stop();
    }
  }

  end() {
    if (!this.hasPendingPlayback()) {
      this.resolveIdleWaiters();
      return;
    }
    if (this.flushSilenceMs > 0) {
      this.write(this.silenceForMs(this.flushSilenceMs));
    }
    this.scheduleIdleResolution();
  }

  pendingPlaybackMs(now = Date.now()) {
    if (!this.enabled || !this.child || this.child.killed) {
      return 0;
    }
    return Math.max(0, this.playbackCursorUntil + this.drainPaddingMs - now);
  }

  hasPendingPlayback() {
    return this.pendingPlaybackMs() > 0;
  }

  scheduleIdleResolution() {
    this.clearIdleTimer();
    const waitMs = this.pendingPlaybackMs();
    if (waitMs <= 0) {
      this.resolveIdleWaiters();
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.resolveIdleWaiters();
    }, waitMs);
  }

  waitForIdle({ timeoutMs = 3000 } = {}) {
    if (!this.hasPendingPlayback()) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const done = () => {
        cleanup();
        resolve(true);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        const index = this.idleWaiters.indexOf(done);
        if (index !== -1) {
          this.idleWaiters.splice(index, 1);
        }
      };
      this.idleWaiters.push(done);
      this.scheduleIdleResolution();
    });
  }

  async interrupt() {
    if (!this.enabled) {
      return;
    }
    this.stop();
  }

  stop() {
    this.clearIdleTimer();
    this.playbackCursorUntil = 0;
    if (!this.child) {
      this.resolveIdleWaiters();
      return;
    }
    if (this.child.stdin?.writable && typeof this.child.stdin.end === 'function') {
      this.child.stdin.end();
    }
    if (!this.child.killed && typeof this.child.kill === 'function') {
      this.child.kill('SIGINT');
    }
    this.child = null;
    this.resolveIdleWaiters();
  }
}
