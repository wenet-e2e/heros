export class SharedContext {
  constructor() {
    this.turns = [];
    this.backgroundTasks = [];
    this.version = 0;
  }

  addTurn(role, content) {
    this.version += 1;
    this.turns.push({
      role,
      content,
      createdAt: new Date().toISOString(),
      contextVersion: this.version,
    });
    if (this.turns.length > 30) {
      this.turns = this.turns.slice(-30);
    }
  }

  addBackgroundTask(task) {
    this.version += 1;
    this.backgroundTasks.push({
      ...task,
      createdAt: new Date().toISOString(),
      contextVersion: this.version,
    });
    if (this.backgroundTasks.length > 20) {
      this.backgroundTasks = this.backgroundTasks.slice(-20);
    }
  }

  snapshot() {
    return {
      contextVersion: this.version,
      turns: this.turns,
      backgroundTasks: this.backgroundTasks,
    };
  }
}
