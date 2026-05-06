import type { ReminderService } from "./ReminderService";
import type { ReminderRequest } from "../voice/types";

export class LocalReminderService implements ReminderService {
  private readonly reminders: ReminderRequest[] = [];

  async createReminder(reminder: ReminderRequest): Promise<void> {
    this.reminders.push(reminder);
  }

  async listReminders(): Promise<ReminderRequest[]> {
    return [...this.reminders];
  }
}
