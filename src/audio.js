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
  constructor({ sampleRate = 24000, enabled = true } = {}) {
    this.sampleRate = sampleRate;
    this.enabled = enabled;
    this.child = null;
    this.available = false;
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
    if (this.child && !this.child.killed) {
      this.stop();
    }
    const child = spawn('play', [
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
    ], { stdio: ['pipe', 'ignore', 'inherit'] });
    this.child = child;
    child.once('close', () => {
      if (this.child !== child) {
        return;
      }
      this.child = null;
    });
  }

  write(chunk) {
    if (!this.enabled) {
      return;
    }
    if (!this.child) {
      this.begin();
    }
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      return;
    }
    this.child.stdin.write(chunk);
  }

  end() {
    if (!this.child || this.child.killed) {
      return;
    }
    if (this.child.stdin?.writable) {
      this.child.stdin.end();
    }
  }

  async interrupt() {
    if (!this.enabled) {
      return;
    }
    this.stop();
  }

  stop() {
    if (!this.child) {
      return;
    }
    if (this.child.stdin?.writable) {
      this.child.stdin.end();
    }
    if (!this.child.killed) {
      this.child.kill('SIGINT');
    }
    this.child = null;
  }
}
