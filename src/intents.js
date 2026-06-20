export function likelyReminder(text) {
  return /提醒|闹钟|记得|到点|明天|今天|后天|分钟后|小时后|am|pm|点|:/.test(text);
}
