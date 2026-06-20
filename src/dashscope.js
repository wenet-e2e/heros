export class DashScopeClient {
  constructor({ apiKey, baseUrl }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, '');
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

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

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
