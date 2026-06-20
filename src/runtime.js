import { BackgroundAgent } from './backgroundAgent.js';
import { ensureAgentBootstrap } from './bootstrap.js';
import { getConfig } from './config.js';
import { SharedContext } from './context.js';
import { DashScopeClient } from './dashscope.js';
import { configureEvents } from './events.js';
import { CliInteractionModel } from './interactionModel.js';
import { MemoryStore } from './memoryStore.js';
import { ReminderScheduler } from './reminderScheduler.js';
import { ReminderStore } from './reminders.js';
import { TaskRouter } from './taskRouter.js';

export function createRuntime() {
  const config = getConfig();
  const client = new DashScopeClient({
    apiKey: config.dashscopeApiKey,
    baseUrl: config.dashscopeBaseUrl,
    timeoutMs: config.dashscopeRequestTimeoutMs,
  });
  const context = new SharedContext();
  const reminderStore = new ReminderStore(config.dataDir);
  configureEvents({ logPath: config.eventLogPath });
  const reminderScheduler = new ReminderScheduler({
    reminderStore,
    pollMs: config.reminderPollMs,
  });
  const bootstrap = ensureAgentBootstrap(config.dataDir);
  const memoryStore = new MemoryStore(bootstrap.files.find((file) => file.endsWith('MEMORY.md')));
  context.setLongTermMemory(memoryStore.list());
  const backgroundAgent = new BackgroundAgent({
    client,
    model: config.backgroundModel,
    reminderStore,
    timeZone: config.timeZone,
  });
  const taskRouter = new TaskRouter({
    backgroundAgent,
    context,
  });
  const interactionModel = new CliInteractionModel({
    client,
    model: config.backgroundModel,
    taskRouter,
    context,
  });
  return {
    config,
    client,
    context,
    interactionModel,
    backgroundAgent,
    taskRouter,
    reminderStore,
    reminderScheduler,
    memoryStore,
    bootstrap,
  };
}
