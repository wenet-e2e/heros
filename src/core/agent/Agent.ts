import { AgentRuntime } from "./AgentRuntime";

export interface AgentResult {
  reply: string;
}

export class Agent {
  private readonly runtime: AgentRuntime;

  constructor(
    options: {
      apiKey?: string;
      model?: string;
      baseUrl?: string;
    } = {}
  ) {
    this.runtime = new AgentRuntime(options);
  }

  async handleUtterance(text: string): Promise<AgentResult> {
    const result = await this.runtime.run(text, {
      onToolTrace: (trace) => {
        console.log(
          `[AgentRuntime] tool=${trace.tool} args=${trace.arguments} result=${trace.result.slice(0, 180)}`
        );
      },
    });
    return { reply: result.reply };
  }
}
