import type { ReminderRequest } from "../voice/types";

function toNextDateAtHour(hour: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(hour, 0, 0, 0);
  return date;
}

export function parseReminderIntent(text: string): ReminderRequest | null {
  const sourceText = text.trim();
  if (!sourceText) {
    return null;
  }

  const relativeMatch = sourceText.match(/(\d+)\s*分钟后提醒我(.+)/);
  if (relativeMatch) {
    const minutes = Number(relativeMatch[1]);
    const content = relativeMatch[2].trim();
    if (!content) {
      return null;
    }

    const triggerAt = new Date(Date.now() + minutes * 60 * 1000);
    return { content, triggerAt, sourceText };
  }

  const tomorrowMatch = sourceText.match(/明天(?:早上|上午|中午|下午|晚上)?\s*(\d{1,2})点提醒我(.+)/);
  if (tomorrowMatch) {
    const hour = Number(tomorrowMatch[1]);
    const content = tomorrowMatch[2].trim();
    if (!content || hour > 23) {
      return null;
    }

    const triggerAt = toNextDateAtHour(hour);
    return { content, triggerAt, sourceText };
  }

  return null;
}
