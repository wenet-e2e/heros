export function likelyReminder(text) {
  const explicitReminder = /提醒|闹钟|到点|叫我|通知我/.test(text);
  const relativeDelay = /\d+\s*(分钟|小时|天)后/.test(text);
  const dayReference = /今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]/.test(text);
  const timeOfDay = /上午|下午|中午|晚上|早上|凌晨|am|pm/i.test(text);
  const clockTime = /([0-2]?\d|[零一二三四五六七八九十两]{1,3})\s*点(半|[零一二三四五六七八九十\d]{1,3}分?)?|[0-2]?\d[:：][0-5]\d/.test(text);
  return explicitReminder || relativeDelay || (dayReference && (timeOfDay || clockTime));
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
