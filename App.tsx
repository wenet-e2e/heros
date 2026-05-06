import { StatusBar, StyleSheet, View } from "react-native";
import { useState } from "react";
import { useHerOSRuntime } from "./src/hooks/useHerOSRuntime";
import { MainScreen } from "./src/ui/screens/MainScreen";
import { SettingsScreen } from "./src/ui/screens/SettingsScreen";
import { PhoneFrame } from "./src/ui/components/PhoneFrame";
import { colors } from "./src/ui/theme/colors";

type Screen = "main" | "settings";

export default function App() {
  const { stage, inputLevel, outputLevel, providerId, sendText } = useHerOSRuntime();
  const [screen, setScreen] = useState<Screen>("main");

  return (
    <View style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />
      <PhoneFrame>
        {screen === "main" ? (
          <MainScreen
            stage={stage}
            inputLevel={inputLevel}
            outputLevel={outputLevel}
            onOpenSettings={() => setScreen("settings")}
          />
        ) : (
          <SettingsScreen
            providerLabel={providerId}
            onBack={() => setScreen("main")}
            onSendText={sendText}
          />
        )}
      </PhoneFrame>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.bg,
  },
});
