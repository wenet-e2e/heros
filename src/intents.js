export function likelyListReminders(text) {
  return /提醒列表|我的提醒|有哪些.*(提醒|闹钟)|查看.*(提醒|闹钟)|列出.*(提醒|闹钟)/.test(text);
}

export function likelyListMemory(text) {
  return /我的记忆|你记得什么|记住了什么|有哪些.*记忆|查看.*记忆|列出.*记忆/.test(text);
}

export function likelyReminder(text) {
  const explicitReminder = /提醒|闹钟|到点|叫我|通知我/.test(text);
  const relativeDelay = /\d+\s*(分钟|小时|天)后/.test(text);
  const dayReference = /今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]/.test(text);
  const clockTime = /([0-2]?\d|[零一二三四五六七八九十两]{1,3})\s*点(半|[零一二三四五六七八九十\d]{1,3}分?)?|[0-2]?\d[:：][0-5]\d/.test(text);
  return explicitReminder || relativeDelay || (dayReference && clockTime);
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

export function extractForgetMemoryQuery(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^(忘记|忘掉|删除记忆|不要记得)[：:，,\s]*(.+)$/);
  if (!match) {
    return '';
  }
  return match[2].trim();
}

export function likelyForgetMemory(text) {
  return Boolean(extractForgetMemoryQuery(text));
}

export function extractCancelReminderQuery(text) {
  const trimmed = text.trim();
  const cancelMatch = trimmed.match(/^取消[：:，,\s]*(.+?)(提醒|闹钟)?$/);
  if (cancelMatch) {
    return cancelMatch[1].replace(/提醒|闹钟/g, '').trim();
  }
  const deleteMatch = trimmed.match(/^(删除|去掉)[：:，,\s]*(.+?)(提醒|闹钟)$/);
  if (deleteMatch) {
    return deleteMatch[2].replace(/提醒|闹钟/g, '').trim();
  }
  return '';
}

export function likelyCancelReminder(text) {
  return Boolean(extractCancelReminderQuery(text));
}
