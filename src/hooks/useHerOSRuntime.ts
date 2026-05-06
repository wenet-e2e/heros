import { useEffect, useMemo, useRef, useState } from "react";
import { createVoiceProvider } from "../core/voice/createVoiceProvider";
import type { VoiceStage } from "../core/voice/types";

export function useHerOSRuntime() {
  const provider = useMemo(() => createVoiceProvider(), []);
  const [stage, setStage] = useState<VoiceStage>("idle");
  const [inputLevel, setInputLevel] = useState(0);
  const [outputLevel, setOutputLevel] = useState(0);
  const inputLevelRef = useRef(0);
  const outputLevelRef = useRef(0);

  useEffect(() => {
    const offStage = provider.on("stage", setStage);
    const offError = provider.on("error", () => setStage("error"));
    const offInputLevel = provider.on("inputLevel", (level) => {
      inputLevelRef.current = Math.max(inputLevelRef.current, level);
    });
    const offOutputLevel = provider.on("outputLevel", (level) => {
      outputLevelRef.current = Math.max(outputLevelRef.current, level);
    });

    const decayTimer = setInterval(() => {
      inputLevelRef.current *= 0.82;
      outputLevelRef.current *= 0.82;
      setInputLevel(inputLevelRef.current);
      setOutputLevel(outputLevelRef.current);
    }, 80);

    void provider.start();

    return () => {
      offStage();
      offError();
      offInputLevel();
      offOutputLevel();
      clearInterval(decayTimer);
      void provider.stop();
    };
  }, [provider]);

  return {
    stage,
    inputLevel,
    outputLevel,
    providerId: provider.id,
    sendText: async (text: string) => {
      await provider.speak(text);
    },
  };
}
