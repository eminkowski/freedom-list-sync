#!/usr/bin/env node

import { Command } from "commander";

import { registerAuthCommands, registerLogoutCommand } from "./commands/auth.js";
import { registerDebugNetworkCommand } from "./commands/debug-network.js";
import { registerDiffCommand } from "./commands/diff.js";
import { registerInspectCommand } from "./commands/inspect.js";
import { registerLoginCommand } from "./commands/login.js";
import { registerProbeBatchCommand } from "./commands/probe-batch.js";
import { registerSyncCommand } from "./commands/sync.js";

const program = new Command();

program
  .name("freedom-list-sync")
  .description("Sync remote domain blocklists with Freedom")
  .version("0.1.0");

registerLoginCommand(program);
registerAuthCommands(program);
registerLogoutCommand(program);
registerInspectCommand(program);
registerDiffCommand(program);
registerSyncCommand(program);
registerDebugNetworkCommand(program);
registerProbeBatchCommand(program);

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
