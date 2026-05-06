import type { ReminderRequest } from "../voice/types";

export interface ReminderService {
  createReminder(reminder: ReminderRequest): Promise<void>;
  listReminders(): Promise<ReminderRequest[]>;
}
