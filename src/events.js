import fs from 'node:fs';
import path from 'node:path';

let eventLogPath = null;
let printEvents = true;
let consoleFormat = process.env.HEROS_EVENT_CONSOLE || 'compact';
const SECRET_REDACTIONS = [
  /\b(DASHSCOPE_API_KEY|API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s,;]+/gi,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
];
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|passwd|authorization|bearer)/i;

const COLORS = Object.freeze({
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
  yellow: '\x1b[33m',
});

export function configureEvents({ logPath, print = true, format } = {}) {
  eventLogPath = logPath || null;
  printEvents = print;
  consoleFormat = format || process.env.HEROS_EVENT_CONSOLE || 'compact';
  if (eventLogPath) {
    fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
  }
}

function redactString(value) {
  return SECRET_REDACTIONS.reduce((text, pattern) => text.replace(pattern, '[REDACTED]'), value);
}

export function redactSecrets(value) {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(item),
      ]),
    );
  }
  return value;
}

function colorize(text, color, enabled) {
  if (!enabled || !COLORS[color]) {
    return text;
  }
  return `${COLORS[color]}${text}${COLORS.reset}`;
}

function shortId(value) {
  if (!value) {
    return '-';
  }
  return String(value).replace(/^(turn|task)_/, '').slice(0, 8);
}

function clip(value, maxLength = 72) {
  if (!value) {
    return '';
  }
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}...`;
}

function resultAction(result) {
  if (!result || typeof result !== 'object') {
    return result ? String(result) : '-';
  }
  if (result.action || result.type) {
    return result.action || result.type;
  }
  if (result.id && result.title) {
    return `reminder:${clip(result.title, 32)}`;
  }
  return result.id ? 'stored_result' : '-';
}

function compactLine(label, colorName, message, { useColor = process.stdout.isTTY && !process.env.NO_COLOR } = {}) {
  return `${colorize(`[${label}]`, colorName, useColor)} ${message}`;
}

export function formatConsoleEvent(event, options = {}) {
  const useColor = options.color ?? (process.stdout.isTTY && !process.env.NO_COLOR);
  const line = (label, color, message) => compactLine(label, color, message, { useColor });
  switch (event.type) {
    case 'transcript.completed':
      return line('interaction', 'cyan', `heard turn=${shortId(event.turnId)} "${clip(event.text)}"`);
    case 'response.started':
      return null;
    case 'response.completed': {
      if (!event.text) {
        return null;
      }
      const label = event.source === 'background_agent' || event.backgroundTaskId ? 'background' : 'interaction';
      const color = label === 'background' ? 'magenta' : 'cyan';
      return line(label, color, `response done turn=${shortId(event.turnId)} source=${event.source || '-'} "${clip(event.text)}"`);
    }
    case 'background_task.requested':
      return line(
        'schedule',
        'magenta',
        `task=${event.taskType || '-'} target=${event.target || '-'} skill=${event.skillId || '-'} reason=${event.reason || '-'} id=${shortId(event.backgroundTaskId)}`,
      );
    case 'background_task.started':
    case 'background_task.progress':
      return null;
    case 'background_task.needs_clarification':
      return line('background', 'magenta', `clarify id=${shortId(event.backgroundTaskId)} "${clip(event.question)}"`);
    case 'background_task.cancelled':
      return line('background', 'yellow', `cancelled id=${shortId(event.backgroundTaskId)} reason=${event.reason || '-'}`);
    case 'background_task.completed':
      return line('background', 'magenta', `done id=${shortId(event.backgroundTaskId)} action=${resultAction(event.result)}`);
    case 'background_task.failed':
      return line('background', 'red', `failed id=${shortId(event.backgroundTaskId)} ${clip(event.message)}`);
    case 'agent.started':
    case 'agent.completed':
      return null;
    case 'skill.invoked':
      return line(
        'skill',
        'green',
        `${event.skillId || '-'} task=${event.taskType || '-'} target=${event.target || '-'} id=${shortId(event.backgroundTaskId)}`,
      );
    case 'tool_call.started':
      return line('tool', 'yellow', `${event.toolName || '-'} start id=${shortId(event.backgroundTaskId)} call=${shortId(event.callId)}`);
    case 'tool_call.completed':
      return line('tool', 'yellow', `${event.toolName || '-'} ok id=${shortId(event.backgroundTaskId)} call=${shortId(event.callId)}`);
    case 'tool_call.failed':
      return line('tool', 'red', `${event.toolName || '-'} failed id=${shortId(event.backgroundTaskId)} call=${shortId(event.callId)} ${clip(event.message)}`);
    case 'error':
      return line('error', 'red', `${event.source || '-'} ${clip(event.message || event.error)}`);
    default:
      if (event.type?.endsWith?.('.failed')) {
        return line('error', 'red', `${event.type} ${clip(event.message || event.error)}`);
      }
      return null;
  }
}

export function emitEvent(type, payload = {}) {
  const event = {
    ...redactSecrets(payload),
    type,
    createdAt: new Date().toISOString(),
  };
  const line = JSON.stringify(event);
  if (printEvents) {
    if (consoleFormat === 'json') {
      process.stdout.write(`[event] ${line}\n`);
    } else {
      const compact = formatConsoleEvent(event);
      if (compact) {
        process.stdout.write(`${compact}\n`);
      }
    }
  }
  if (eventLogPath) {
    fs.appendFileSync(eventLogPath, `${line}\n`);
  }
  return event;
}
