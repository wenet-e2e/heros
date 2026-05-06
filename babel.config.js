module.exports = {
  presets: ["module:@react-native/babel-preset"],
  plugins: [
    [
      "transform-inline-environment-variables",
      {
        include: [
          "HEROS_VOICE_PROVIDER",
          "HEROS_DEMO_UTTERANCE",
          "HEROS_DOUBAO_BASE_URL",
          "HEROS_DOUBAO_APP_ID",
          "HEROS_DOUBAO_ACCESS_KEY",
          "HEROS_DOUBAO_RESOURCE_ID",
          "HEROS_DOUBAO_APP_KEY",
          "HEROS_DOUBAO_SPEAKER",
          "HEROS_DOUBAO_BOT_NAME",
          "HEROS_DOUBAO_SYSTEM_ROLE",
          "HEROS_DOUBAO_SPEAKING_STYLE",
          "HEROS_DOUBAO_GREETING",
          "HEROS_LLM_API_KEY",
          "HEROS_LLM_MODEL",
          "HEROS_LLM_BASE_URL",
          "HEROS_AGENT_WORKSPACE_DIR",
        ],
      },
    ],
  ],
};
