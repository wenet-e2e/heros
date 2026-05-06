#!/usr/bin/env node

import { runAgentTextCli } from "../src/core/agent/node/cli.mjs";

runAgentTextCli().catch((e) => {
  console.error("[agent-text] fatal:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
