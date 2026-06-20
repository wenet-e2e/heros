import { emitEvent } from './events.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function connectRealtimeWithRetry(realtime, { retries = 0, delayMs = 500 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      attempt += 1;
      await realtime.connect();
      if (attempt > 1) {
        emitEvent('realtime.connect_recovered', { attempt });
      }
      return;
    } catch (error) {
      emitEvent('realtime.connect_failed', {
        attempt,
        retries,
        message: error.message,
      });
      if (attempt > retries) {
        throw error;
      }
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }
}
