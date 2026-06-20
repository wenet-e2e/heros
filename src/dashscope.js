import { redactSecrets } from './events.js';

export class DashScopeClient {
  constructor({ apiKey, baseUrl, timeoutMs = 60000 }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async chatCompletion({ model, messages, temperature = 0.5, responseFormat, stream = false, signal }) {
    const body = {
      model,
      messages,
      temperature,
      stream,
    };
    if (responseFormat) {
      body.response_format = responseFormat;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) {
        controller.abort(signal.reason);
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    let response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (signal?.aborted) {
        if (signal.reason instanceof Error) {
          throw signal.reason;
        }
        throw new Error(`DashScope request aborted: ${signal.reason || 'cancelled'}`);
      }
      if (error.name === 'AbortError') {
        throw new Error(timedOut
          ? `DashScope request timed out after ${this.timeoutMs}ms`
          : 'DashScope request aborted');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }

    if (!response.ok) {
      const text = redactSecrets(await response.text());
      throw new Error(`DashScope request failed: ${response.status} ${response.statusText}\n${text}`);
    }

    if (stream) {
      return response.body;
    }

    return response.json();
  }

  async text({ model, messages, temperature = 0.5, responseFormat, signal }) {
    const json = await this.chatCompletion({ model, messages, temperature, responseFormat, signal });
    return json?.choices?.[0]?.message?.content ?? '';
  }
}
