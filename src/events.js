export function emitEvent(type, payload = {}) {
  const event = {
    type,
    createdAt: new Date().toISOString(),
    ...payload,
  };
  process.stdout.write(`[event] ${JSON.stringify(event)}\n`);
}
