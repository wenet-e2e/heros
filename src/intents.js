export function likelyReminder(text) {
  return /提醒|闹钟|到点|明天|今天|后天|分钟后|小时后|am|pm|点|:/.test(text);
}

export function extractMemoryContent(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^(请)?(帮我)?记住[：:，,\s]*(.+)$/);
  if (!match) {
    return '';
  }
  return match[3].trim();
}

export function likelyMemory(text) {
  return Boolean(extractMemoryContent(text));
}

export function extractCancelReminderQuery(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^(取消|删除|去掉)[：:，,\s]*(.+?)(提醒|闹钟)?$/);
  if (!match) {
    return '';
  }
  return match[2].replace(/提醒|闹钟/g, '').trim();
}

export function likelyCancelReminder(text) {
  return Boolean(extractCancelReminderQuery(text));
}
