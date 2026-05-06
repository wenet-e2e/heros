import type { PropsWithChildren } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { colors } from "../theme/colors";

const PHONE_RATIO = 9 / 19.5;

export function PhoneFrame({ children }: PropsWithChildren) {
  const { width, height } = useWindowDimensions();
  const maxFrameHeight = Math.max(height, 320);
  const maxFrameWidth = Math.max(width, 240);
  const frameWidth = Math.min(maxFrameWidth, maxFrameHeight * PHONE_RATIO);
  const frameHeight = frameWidth / PHONE_RATIO;

  return (
    <View style={styles.outer}>
      <View style={[styles.frame, { width: frameWidth, height: frameHeight }]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  frame: {
    borderRadius: 36,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    shadowColor: "#E8ABD9",
    shadowOpacity: 0.5,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 12,
  },
});
