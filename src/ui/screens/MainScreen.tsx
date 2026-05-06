import { NativeModules, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusOrb } from "../components/StatusOrb";
import type { VoiceStage } from "../../core/voice/types";
import { colors } from "../theme/colors";

interface MainScreenProps {
  stage: VoiceStage;
  inputLevel: number;
  outputLevel: number;
  onOpenSettings: () => void;
}

export function MainScreen({ stage, inputLevel, outputLevel, onOpenSettings }: MainScreenProps) {
  const openDevTools = () => {
    const devSettings = (NativeModules as { DevSettings?: { openDebugger?: () => void } }).DevSettings;
    devSettings?.openDebugger?.();
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable onPress={onOpenSettings} style={styles.settingsButton}>
          <View style={styles.dots}>
            <View style={styles.dot} />
            <View style={styles.dot} />
            <View style={styles.dot} />
          </View>
        </Pressable>
      </View>
      <View style={styles.center}>
        <View style={styles.topSpacer} />
        <StatusOrb stage={stage} inputLevel={inputLevel} outputLevel={outputLevel} />
        <View style={styles.bottomSpacer} />
      </View>
      <View style={styles.footer}>
        <Text style={styles.slogan}>HerOS - Sensation and action in every conversation.</Text>
        {__DEV__ ? (
          <Pressable onPress={openDevTools} style={styles.devToolsButton}>
            <Text style={styles.devToolsText}>Open DevTools</Text>
          </Pressable>
        ) : null}
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
    height: Platform.OS === "macos" ? 92 : 72,
    paddingTop: Platform.OS === "macos" ? 14 : 0,
    paddingHorizontal: 20,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  settingsButton: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
    borderRadius: 18,
    width: 52,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  dots: {
    flexDirection: "row",
    gap: 5,
    alignItems: "center",
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.textPrimary,
  },
  center: {
    flex: 1,
    alignItems: "center",
  },
  topSpacer: {
    flex: 0.382,
  },
  bottomSpacer: {
    flex: 0.618,
  },
  footer: {
    paddingBottom: 26,
    alignItems: "center",
  },
  slogan: {
    color: colors.textMuted,
    fontSize: 12,
  },
  devToolsButton: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.panel,
  },
  devToolsText: {
    color: colors.textMuted,
    fontSize: 11,
  },
});
