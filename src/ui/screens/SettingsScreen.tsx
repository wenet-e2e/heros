import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { colors } from "../theme/colors";

interface SettingsScreenProps {
  providerLabel: string;
  onBack: () => void;
  onSendText: (text: string) => Promise<void>;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export function SettingsScreen({ providerLabel, onBack, onSendText }: SettingsScreenProps) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) {
      return;
    }
    try {
      setSending(true);
      await onSendText(text);
      setInput("");
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.backButton}>
          <Text style={styles.backText}>返回</Text>
        </Pressable>
      </View>

      <View style={styles.content}>
        <Text style={styles.title}>设置</Text>
        <Row label="语音 Provider" value={providerLabel} />
        <Row label="麦克风权限" value="待接入" />
        <Row label="通知权限" value="待接入" />
        <Row label="提醒执行方式" value="本地提醒" />
        <View style={styles.row}>
          <Text style={styles.rowLabel}>调试对话（直连豆包）</Text>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder="输入一句话发送给豆包"
            placeholderTextColor={colors.textMuted}
            style={styles.input}
          />
          <Pressable onPress={() => void send()} style={styles.sendButton}>
            <Text style={styles.sendText}>{sending ? "发送中..." : "发送文本"}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  header: {
    height: 72,
    paddingHorizontal: 20,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  backButton: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  backText: {
    color: colors.textPrimary,
    fontSize: 14,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 14,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 26,
    fontWeight: "700",
    marginBottom: 8,
  },
  row: {
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  rowLabel: {
    color: colors.textMuted,
    fontSize: 12,
  },
  rowValue: {
    color: colors.textPrimary,
    fontSize: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: "#FFF9FD",
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    color: colors.textPrimary,
    fontSize: 14,
  },
  sendButton: {
    marginTop: 6,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#FFEAF6",
  },
  sendText: {
    color: colors.textPrimary,
    fontSize: 13,
  },
});
