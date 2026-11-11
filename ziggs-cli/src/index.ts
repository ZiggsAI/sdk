#!/usr/bin/env node
import { Command } from 'commander';
import { cliVersion, resolveApiBase } from './creds.js';
import { renewStoredKey, storedKeyExpired } from './keyStore.js';
import { registerInboxCommand } from './commands/inbox.js';
import { registerReadCommand } from './commands/read.js';
import { registerChatsCommands } from './commands/chats.js';
import { registerAgentsCommands } from './commands/agents.js';
import { registerAgreementsCommands } from './commands/agreements.js';
import { registerTasksCommands } from './commands/tasks.js';
import { registerGrantsCommands } from './commands/grants.js';
import { registerContextCommands } from './commands/context.js';
import { registerAssistantCommands } from './commands/assistant.js';
import { registerInviteCommands } from './commands/invite.js';

const program = new Command();

program
  .name('ziggs')
  .description('Ziggs CLI — terminal interface for your delegate agent')
  .version(cliVersion)
  .option('--json', 'output raw JSON (for agent/script consumption)')
  .option('--session <id>', 'stable assistant chat ID (or ZIGGS_SESSION_ID)')
  .option('--app <name>', 'assistant host label, e.g. Codex or Claude Code')
  .option('--session-name <name>', 'human-readable chat label')
  .option('--workspaces <ids>', 'comma-separated workspace IDs to narrow this session');

registerAssistantCommands(program);
registerInviteCommands(program);

registerInboxCommand(program);
registerReadCommand(program);
registerChatsCommands(program);
registerAgentsCommands(program);
registerAgreementsCommands(program);
registerTasksCommands(program);
registerGrantsCommands(program);
registerContextCommands(program);

program.hook('preAction', (_root, command) => {
  let top = command;
  while (top.parent && top.parent !== program) top = top.parent;
  const options = program.opts();
  if ((options.session || options.app || options.sessionName || options.workspaces || process.env.ZIGGS_SESSION_ID) &&
      !['session', 'tools', 'describe', 'call'].includes(top.name())) {
    throw new Error('Assistant session options require session, tools, describe, or call. Use ziggs call with the operation from ziggs tools; legacy shorthand commands are not session-aware.');
  }
});

// Commands that never send the key; renewing first would only add a request.
// `join` also has to work when the saved key is past saving.
const KEYLESS = new Set(['join', 'session new', 'session status']);

program.hook('preAction', async (_root, command) => {
  const parent = command.parent && command.parent !== program ? `${command.parent.name()} ` : '';
  if (KEYLESS.has(`${parent}${command.name()}`)) return;
  // A key from `ziggs join` lasts an hour. Renew it before the command uses it.
  const apiBase = resolveApiBase();
  if ((await renewStoredKey(apiBase)) === 'failed' && storedKeyExpired(apiBase)) {
    throw new Error(
      'The key ziggs join saved has expired and could not be renewed. Run ziggs join --forget-key, then ziggs join with a new introduction string, or set ZIGGS_OPERATOR_KEY.',
    );
  }
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(program.opts().json ? JSON.stringify({ error: message }) : message);
  process.exitCode = 1;
});
