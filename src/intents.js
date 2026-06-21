export function likelyNextReminder(text) {
  return /下一个.*(提醒|闹钟)|最近.*(提醒|闹钟)/.test(text);
}

export function likelyUpdateReminder(text) {
  return /(修改|改|调整|推迟|提前|换个时间|改到|改成).*(提醒|闹钟)|(提醒|闹钟).*(修改|改|调整|推迟|提前|换个时间|改到|改成)/.test(text);
}

export function likelyListReminders(text) {
  return /提醒列表|我的提醒|有哪些.*(提醒|闹钟)|查看.*(提醒|闹钟)|查询.*(提醒|闹钟)|列出.*(提醒|闹钟)|下一个.*(提醒|闹钟)|最近.*(提醒|闹钟)/.test(text);
}

export function likelyListMemory(text) {
  return /我的记忆|你记得什么|记住了什么|有哪些.*记忆|查看.*记忆|查询.*记忆|列出.*记忆|长期记忆/.test(text);
}

export function extractUpdateMemoryPatch(text) {
  const trimmed = text.trim();
  if (!/(记忆|记得|记住)/.test(trimmed)) {
    return { query: '', content: '' };
  }
  const replaceMatch = trimmed.match(/^把(?:长期)?(?:记忆里|记忆中|你记得的|你记住的)?[：:，,\s]*(.+?)(?:这条)?(?:(?:长期)?记忆)?(?:改成|改为|更新为|改到)[：:，,\s]*(.+)$/);
  if (replaceMatch) {
    return {
      query: replaceMatch[1].replace(/这条|记忆/g, '').trim(),
      content: replaceMatch[2].trim(),
    };
  }
  const updateMatch = trimmed.match(/^(?:更新|修改)(?:长期)?记忆[：:，,\s]*(.+?)(?:为|成|到)[：:，,\s]*(.+)$/);
  if (updateMatch) {
    return {
      query: updateMatch[1].replace(/这条|记忆/g, '').trim(),
      content: updateMatch[2].trim(),
    };
  }
  return { query: '', content: '' };
}

export function likelyUpdateMemory(text) {
  const patch = extractUpdateMemoryPatch(text);
  if (patch.query && patch.content) {
    return true;
  }
  const trimmed = text.trim();
  return /^(更新|修改)(?:长期)?记忆$/.test(trimmed) || /^把(?:长期)?(?:记忆|记忆里|记忆中)/.test(trimmed);
}

export function likelyReminder(text) {
  const explicitReminder = /提醒|闹钟|到点|叫我|通知我/.test(text);
  const relativeDelay = /\d+\s*(分钟|小时|天)后/.test(text);
  return explicitReminder || relativeDelay;
}

export function extractMemoryContent(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^(请)?(帮我)?记住[：:，,\s]*(.+)$/);
  if (match) {
    return match[3].trim();
  }
  return extractDurableMemoryContent(trimmed);
}

function normalizeFirstPersonMemory(text) {
  return text
    .replace(/^我/, '用户')
    .replace(/^我的/, '用户的');
}

export function extractDurableMemoryContent(text) {
  const trimmed = text.trim();
  if (!trimmed || /(密码|密钥|令牌|token|secret|api[_-]?key)/i.test(trimmed)) {
    return '';
  }
  if (/(提醒|闹钟|到点|叫我|通知我)/.test(trimmed)) {
    return '';
  }
  const preference = trimmed.match(/^我(喜欢|爱|更喜欢|偏好|讨厌|不喜欢|习惯|常用)(.+)$/);
  if (preference) {
    return normalizeFirstPersonMemory(trimmed);
  }
  const assistantPreference = trimmed.match(/^我(希望|想要)你(?:以后|之后|今后)?(.+)$/);
  if (assistantPreference) {
    return normalizeFirstPersonMemory(trimmed);
  }
  const identity = trimmed.match(/^我(叫|是)(.+)$/);
  if (identity) {
    return normalizeFirstPersonMemory(trimmed);
  }
  const profile = trimmed.match(/^我的([^，。,.!?！？]{1,12})(是|叫|为)[：:，,\s]*(.+)$/);
  if (profile && !/(密码|密钥|令牌|token|secret|api[_-]?key)/i.test(profile[1])) {
    return normalizeFirstPersonMemory(trimmed);
  }
  return '';
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
  const trimmed = text.trim();
  return Boolean(extractForgetMemoryQuery(trimmed)) || /^(忘记|忘掉|删除记忆|不要记得)$/.test(trimmed);
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
  const trimmed = text.trim();
  return Boolean(extractCancelReminderQuery(trimmed)) || /^(取消|删除|去掉)[：:，,\s]*(提醒|闹钟)$/.test(trimmed);
}
