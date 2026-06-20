import { BackgroundAgent } from './backgroundAgent.js';
import { ensureAgentBootstrap, readAgentBootstrap } from './bootstrap.js';
import { getConfig } from './config.js';
import { SharedContext } from './context.js';
import { DashScopeClient } from './dashscope.js';
import { readEventLog, summarizeBackgroundTasks, summarizeTurns } from './eventLog.js';
import { configureEvents } from './events.js';
import { CliInteractionModel } from './interactionModel.js';
import { MemoryStore } from './memoryStore.js';
import { ReminderScheduler } from './reminderScheduler.js';
import { ReminderStore } from './reminders.js';
import { TaskRouter } from './taskRouter.js';

export function createRuntime({ printEvents = true, requireApiKey = true } = {}) {
  const config = getConfig({ requireApiKey });
  const client = new DashScopeClient({
    apiKey: config.dashscopeApiKey,
    baseUrl: config.dashscopeBaseUrl,
    timeoutMs: config.dashscopeRequestTimeoutMs,
  });
  const context = new SharedContext();
  const reminderStore = new ReminderStore(config.dataDir);
  configureEvents({ logPath: config.eventLogPath, print: printEvents });
  const loggedEvents = readEventLog(config.eventLogPath);
  context.hydrate({
    turns: summarizeTurns(loggedEvents).turns.slice(-30),
    backgroundTasks: summarizeBackgroundTasks(loggedEvents).tasks.slice(0, 20),
  });
  const reminderScheduler = new ReminderScheduler({
    reminderStore,
    pollMs: config.reminderPollMs,
  });
  const bootstrap = ensureAgentBootstrap(config.dataDir);
  const agentBootstrap = readAgentBootstrap(bootstrap.files);
  const memoryStore = new MemoryStore(bootstrap.files.find((file) => file.endsWith('MEMORY.md')));
  context.setLongTermMemory(memoryStore.list());
  const backgroundAgent = new BackgroundAgent({
    agentBootstrap,
    client,
    model: config.backgroundModel,
    reminderStore,
    timeZone: config.timeZone,
  });
  const taskRouter = new TaskRouter({
    backgroundAgent,
    context,
    memoryStore,
    reminderStore,
    taskTimeoutMs: config.backgroundTaskTimeoutMs,
    timeZone: config.timeZone,
  });
  const interactionModel = new CliInteractionModel({
    agentBootstrap,
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
    agentBootstrap,
  };
}
