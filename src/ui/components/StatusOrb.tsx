import { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import type { VoiceStage } from "../../core/voice/types";
import { colors } from "../theme/colors";

interface StatusOrbProps {
  stage: VoiceStage;
  inputLevel: number;
  outputLevel: number;
}

function stageToColor(stage: VoiceStage): string {
  switch (stage) {
    case "listening":
      return colors.orbListening;
    case "thinking":
      return colors.orbThinking;
    case "speaking":
      return colors.orbSpeaking;
    case "error":
      return colors.orbError;
    case "idle":
    default:
      return colors.orbIdle;
  }
}

function stageToScale(_stage: VoiceStage): number {
  return 1;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function StatusOrb({ stage, inputLevel, outputLevel }: StatusOrbProps) {
  const orbPulse = useRef(new Animated.Value(1)).current;
  const auraPulse = useRef(new Animated.Value(1)).current;
  const largePulse = useRef(new Animated.Value(1)).current;
  const mediumPulse = useRef(new Animated.Value(1)).current;
  const smallPulse = useRef(new Animated.Value(1)).current;
  const runningAnimations = useRef<Animated.CompositeAnimation[]>([]);

  const targetScale = useMemo(() => stageToScale(stage), [stage]);
  const color = useMemo(() => stageToColor(stage), [stage]);
  const layerOpacity = useMemo(() => {
    switch (stage) {
      case "listening":
        return { large: 0.2, medium: 0.28, small: 0.88 };
      case "thinking":
        return { large: 0.24, medium: 0.9, small: 0.3 };
      case "speaking":
        return { large: 0.92, medium: 0.3, small: 0.24 };
      case "error":
        return { large: 0.5, medium: 0.5, small: 0.5 };
      case "idle":
      default:
        return { large: 0.3, medium: 0.35, small: 0.38 };
    }
  }, [stage]);

  useEffect(() => {
    for (const animation of runningAnimations.current) {
      animation.stop();
    }
    runningAnimations.current = [];

    orbPulse.setValue(1);
    auraPulse.setValue(1);
    largePulse.setValue(1);
    mediumPulse.setValue(1);
    smallPulse.setValue(1);

    const makePulse = (value: Animated.Value, toValue: number, duration: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue,
            duration,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(value, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ])
      );

    const orbLoop = Animated.timing(orbPulse, {
      toValue: targetScale,
      duration: 1,
      useNativeDriver: true,
    });
    runningAnimations.current.push(orbLoop);
    orbLoop.start();

    let activeLoop: Animated.CompositeAnimation | null = null;
    if (stage === "listening") {
      const micBoost = Math.pow(clamp(inputLevel, 0, 1), 0.45);
      const peak = 1.3 + micBoost * 0.2; // up to 1.5
      activeLoop = makePulse(smallPulse, peak, 320);
      const auraLoop = makePulse(auraPulse, 1.08 + micBoost * 0.12, 560);
      runningAnimations.current.push(auraLoop);
      auraLoop.start();
    } else if (stage === "thinking") {
      activeLoop = makePulse(mediumPulse, 1.45, 620);
      const auraLoop = makePulse(auraPulse, 1.1, 900);
      runningAnimations.current.push(auraLoop);
      auraLoop.start();
    } else if (stage === "speaking") {
      const speakerBoost = Math.pow(clamp(outputLevel, 0, 1), 0.45);
      const peak = 1.3 + speakerBoost * 0.2; // up to 1.5
      activeLoop = makePulse(largePulse, peak, 320);
      const auraLoop = makePulse(auraPulse, 1.1 + speakerBoost * 0.14, 560);
      runningAnimations.current.push(auraLoop);
      auraLoop.start();
    } else if (stage === "error") {
      activeLoop = makePulse(mediumPulse, 1.2, 900);
    }

    if (activeLoop) {
      runningAnimations.current.push(activeLoop);
      activeLoop.start();
    }

    return () => {
      for (const animation of runningAnimations.current) {
        animation.stop();
      }
      runningAnimations.current = [];
    };
  }, [auraPulse, inputLevel, largePulse, mediumPulse, orbPulse, outputLevel, smallPulse, stage, targetScale]);

  return (
    <View style={styles.wrapper}>
      <Animated.View style={[styles.aura, { transform: [{ scale: auraPulse }] }]} />
      <Animated.View style={[styles.orb, { backgroundColor: color, transform: [{ scale: orbPulse }] }]}>
        <Animated.View
          style={[
            styles.gradientLayerA,
            { opacity: layerOpacity.large, transform: [{ scale: largePulse }] },
          ]}
        />
        <Animated.View
          style={[
            styles.gradientLayerB,
            { opacity: layerOpacity.medium, transform: [{ scale: mediumPulse }] },
          ]}
        />
        <Animated.View
          style={[
            styles.gradientLayerC,
            { opacity: layerOpacity.small, transform: [{ scale: smallPulse }] },
          ]}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
  aura: {
    position: "absolute",
    width: 176,
    height: 176,
    borderRadius: 88,
    backgroundColor: "rgba(246, 183, 230, 0.28)",
  },
  orb: {
    width: 144,
    height: 144,
    borderRadius: 72,
    overflow: "hidden",
    shadowColor: "#FF98D6",
    shadowOpacity: 0.42,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  gradientLayerA: {
    position: "absolute",
    width: 140,
    height: 140,
    borderRadius: 70,
    left: 2,
    top: 4,
    backgroundColor: "rgba(255,255,255,0.45)",
  },
  gradientLayerB: {
    position: "absolute",
    width: 110,
    height: 110,
    borderRadius: 55,
    right: -8,
    top: 8,
    backgroundColor: "rgba(219, 176, 255, 0.48)",
  },
  gradientLayerC: {
    position: "absolute",
    width: 82,
    height: 82,
    borderRadius: 41,
    left: 8,
    bottom: -8,
    backgroundColor: "rgba(255, 173, 216, 0.6)",
  },
});
