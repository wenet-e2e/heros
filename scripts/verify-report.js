#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureEvents, emitEvent } from '../src/events.js';

const SECRET_REDACTIONS = [
  /\b(DASHSCOPE_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s,;]+/gi,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
];

function redact(text) {
  return SECRET_REDACTIONS.reduce((value, pattern) => value.replace(pattern, '[REDACTED]'), text || '');
}

function outputTail(text, maxLength = 5000) {
  const safeText = redact(text);
  return safeText.length > maxLength ? safeText.slice(-maxLength) : safeText;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function reportDir() {
  return path.join(process.env.HEROS_DATA_DIR || path.join(process.cwd(), '.heros'), 'verify-reports');
}

function eventLogPath() {
  return process.env.HEROS_EVENT_LOG_PATH
    || path.join(process.env.HEROS_DATA_DIR || path.join(process.cwd(), '.heros'), 'events.ndjson');
}

function runStep(name) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const result = spawnSync('npm', ['run', name], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  return {
    name,
    command: `npm run ${name}`,
    status: result.status,
    signal: result.signal || null,
    ok: result.status === 0,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    stdoutTail: outputTail(stdout),
    stderrTail: outputTail(stderr),
  };
}

const steps = ['check', 'doctor', 'smoke:background', 'smoke:realtime'];
const startedAt = new Date().toISOString();
const report = {
  phase: 'phase_1_no_ui_cli',
  type: 'verify_report',
  startedAt,
  endedAt: null,
  ok: false,
  steps: [],
};

for (const step of steps) {
  const result = runStep(step);
  report.steps.push(result);
  if (!result.ok) {
    break;
  }
}

report.endedAt = new Date().toISOString();
report.ok = report.steps.length === steps.length && report.steps.every((step) => step.ok);

const dir = reportDir();
fs.mkdirSync(dir, { recursive: true });
const filePath = path.join(dir, `verify-report-${timestamp()}.json`);
fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`);
configureEvents({ logPath: eventLogPath() });
emitEvent('verify_report.created', {
  phase: report.phase,
  ok: report.ok,
  reportPath: filePath,
  stepCount: report.steps.length,
  failedStep: report.steps.find((step) => !step.ok)?.name || null,
});
console.log(`Verify report: ${filePath}`);

if (!report.ok) {
  process.exit(1);
}
