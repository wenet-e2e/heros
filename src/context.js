import crypto from 'node:crypto';
import { redactSecrets } from './events.js';

function createTurnId() {
  return `turn_${crypto.randomUUID()}`;
}

export class SharedContext {
  constructor() {
    this.turns = [];
    this.backgroundTasks = [];
    this.longTermMemory = [];
    this.skills = [];
    this.version = 0;
  }

  addTurn(role, content) {
    this.version += 1;
    const turn = {
      id: createTurnId(),
      role,
      content: redactSecrets(content),
      createdAt: new Date().toISOString(),
      contextVersion: this.version,
    };
    this.turns.push(turn);
    if (this.turns.length > 30) {
      this.turns = this.turns.slice(-30);
    }
    return turn;
  }

  addBackgroundTask(task) {
    this.version += 1;
    this.backgroundTasks.push({
      ...redactSecrets(task),
      createdAt: new Date().toISOString(),
      contextVersion: this.version,
    });
    if (this.backgroundTasks.length > 20) {
      this.backgroundTasks = this.backgroundTasks.slice(-20);
    }
  }

  setLongTermMemory(memories) {
    const next = memories.map((memory) => ({
      id: memory.id,
      content: memory.content,
      updatedAt: memory.updatedAt,
    }));
    if (JSON.stringify(next) === JSON.stringify(this.longTermMemory)) {
      return;
    }
    this.version += 1;
    this.longTermMemory = next;
  }

  setSkills(skills) {
    const next = skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      version: skill.version,
      description: skill.description,
      capabilities: skill.capabilities || [],
      tools: skill.tools || [],
    }));
    if (JSON.stringify(next) === JSON.stringify(this.skills)) {
      return;
    }
    this.version += 1;
    this.skills = next;
  }

  hydrate({ backgroundTasks = [], turns = [] } = {}) {
    const hydratedTurns = turns.map((turn) => ({
      id: turn.turnId || turn.id,
      role: turn.role,
      content: redactSecrets(turn.text || turn.content || ''),
      createdAt: turn.createdAt || null,
      contextVersion: Number.isFinite(turn.contextVersion) ? turn.contextVersion : 0,
    })).filter((turn) => turn.id && turn.role && turn.content).slice(-30);

    const hydratedTasks = backgroundTasks.map((task) => ({
      backgroundTaskId: task.backgroundTaskId,
      turnId: task.turnId || null,
      type: task.taskType || task.type || null,
      status: task.status || 'observed',
      result: redactSecrets(task.result || null),
      createdAt: task.startedAt || task.updatedAt || null,
      contextVersion: Number.isFinite(task.contextVersion) ? task.contextVersion : 0,
    })).filter((task) => task.backgroundTaskId).sort((a, b) => {
      const aTime = Date.parse(a.createdAt || 0);
      const bTime = Date.parse(b.createdAt || 0);
      return aTime - bTime;
    }).slice(-20);

    this.turns = hydratedTurns;
    this.backgroundTasks = hydratedTasks;
    this.version = Math.max(
      this.version,
      ...hydratedTurns.map((turn) => turn.contextVersion || 0),
      ...hydratedTasks.map((task) => task.contextVersion || 0),
    );
  }

  snapshot() {
    return {
      contextVersion: this.version,
      turns: this.turns,
      backgroundTasks: this.backgroundTasks,
      longTermMemory: this.longTermMemory,
      skills: this.skills,
    };
  }
}
