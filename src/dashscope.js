export class DashScopeClient {
  constructor({ apiKey, baseUrl, timeoutMs = 60000 }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async chatCompletion({ model, messages, temperature = 0.5, responseFormat, stream = false }) {
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
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
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
      if (error.name === 'AbortError') {
        throw new Error(`DashScope request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`DashScope request failed: ${response.status} ${response.statusText}\n${text}`);
    }

    if (stream) {
      return response.body;
    }

    return response.json();
  }

  async text({ model, messages, temperature = 0.5, responseFormat }) {
    const json = await this.chatCompletion({ model, messages, temperature, responseFormat });
    return json?.choices?.[0]?.message?.content ?? '';
  }
}
