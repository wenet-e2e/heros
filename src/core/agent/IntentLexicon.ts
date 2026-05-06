const EMPTY_LIKE_TOKENS = new Set(["...", "。", "……", "嗯", "呃", "啊", "诶", "[noise]", "[silence]"]);

const GREETING_KEYWORDS = [
  "你好",
  "你好呀",
  "早上好",
  "中午好",
  "下午好",
  "晚上好",
  "晚安",
  "谢谢",
  "最近怎么样",
  "在吗",
];

const EXPLICIT_COMMAND_KEYWORDS = [
  "提醒",
  "帮我",
  "帮我看",
  "看一下",
  "看下",
  "查一下",
  "查一查",
  "查查",
  "查询",
  "读取",
  "打开",
  "关闭",
  "创建",
  "新增",
  "修改",
  "更新",
  "删除",
  "记住",
  "记录",
  "安排",
  "发送",
  "发给",
  "分钟后",
  "小时后",
  "今天",
  "明天",
  "几点",
  "什么时候",
  "多少",
  "多大",
  "怎么查",
  "内存",
  "cpu",
  "磁盘",
  "电量",
];

const DANGEROUS_OPERATION_KEYWORDS = [
  "删除所有",
  "全部删除",
  "清空",
  "覆盖",
  "重写",
  "发送给",
  "转发",
  "分享",
  "付款",
  "支付",
  "转账",
  "sudo",
  "rm ",
  "rm -rf",
];

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function includesAny(source: string, keywords: string[]): boolean {
  return keywords.some((keyword) => source.includes(keyword));
}

function isPunctuationOnly(text: string): boolean {
  const cleaned = text.replace(/[\s\p{P}\p{S}]/gu, "");
  return cleaned.length === 0;
}

export function isEmptyLikeInput(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return true;
  if (EMPTY_LIKE_TOKENS.has(normalized)) return true;
  return isPunctuationOnly(normalized);
}

export function isGreetingInput(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return includesAny(normalized, GREETING_KEYWORDS);
}

export function isExplicitChitchatInput(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  const simplified = normalized.replace(/[\s，。！？!?,.]/g, "");
  if (!simplified) return false;
  const pureGreetings = new Set([
    "你好",
    "你好呀",
    "早上好",
    "中午好",
    "下午好",
    "晚上好",
    "晚安",
    "谢谢",
    "在吗",
    "最近怎么样",
  ]);
  return pureGreetings.has(simplified);
}

export function isDangerousOperationInput(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return includesAny(normalized, DANGEROUS_OPERATION_KEYWORDS);
}

export function isExplicitCommandInput(text: string): boolean {
  const normalized = normalize(text);
  if (!normalized) return false;
  return includesAny(normalized, EXPLICIT_COMMAND_KEYWORDS);
}

