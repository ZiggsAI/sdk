import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  AssistantConnectionClient,
  InboxClient,
  SessionsClient,
  decodeOperatorKeyClaims,
} from '@ziggs-ai/api-client';
import { assistantCredentials, assistantOperations, assistantSession } from '../assistant.js';
import { print } from '../output.js';

export async function readArguments(options: { args?: string; argsFile?: string }): Promise<Record<string, unknown>> {
  if (options.args !== undefined && options.argsFile !== undefined) throw new Error('Use either --args or --args-file, not both.');
  let raw = options.args ?? '{}';
  if (options.argsFile === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    raw = Buffer.concat(chunks).toString('utf8');
  } else if (options.argsFile) raw = await readFile(options.argsFile, 'utf8');
  let args: unknown;
  try { args = JSON.parse(raw); } catch { throw new Error('Arguments must be valid JSON. Prefer --args-file for message text or complex inputs.'); }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be a JSON object.');
  return args as Record<string, unknown>;
}

export function registerAssistantCommands(program: Command): void {
  const session = program.command('session').description('Create or inspect a stable assistant chat identity (local, no credentials printed)');
  session.command('new').description('Generate an ID once; reuse it on every command in this chat').action(() => {
    print({ sessionId: randomUUID() }, Boolean(program.opts().json));
  });
  session.command('status').description('Show this command’s non-secret session metadata').action(() => {
    print(assistantSession(program.opts()), Boolean(program.opts().json));
  });
  session.command('release').description('Release this session’s inbox lease after finishing or stopping work').action(async () => {
    const creds = assistantCredentials(program.opts());
    const result = decodeOperatorKeyClaims(creds.operatorKey)?.connectionClientId
      ? await new AssistantConnectionClient(creds).request('inbox/release', {})
      : await new InboxClient(creds.operatorKey, creds.agentId, undefined, creds.instanceId, creds).releaseHost();
    print(result, Boolean(program.opts().json));
  });
  // Sibling windows of this assistant (list / hold).
  session.command('list').description('List open windows of this assistant and the chats each holds').action(async () => {
    const creds = assistantCredentials(program.opts());
    print({ sessions: await new SessionsClient(creds).list() }, Boolean(program.opts().json));
  });
  session
    .command('hold <chat>')
    .description('Hold a chat in this window (takes it off any sibling)')
    .action(async (chat: string) => {
      const creds = assistantCredentials(program.opts());
      print(await new SessionsClient(creds).hold(chat), Boolean(program.opts().json));
    });

  program.command('tools [search]').description('List available Ziggs operations; optionally search by intent').action(async (search?: string) => {
    const operations = assistantOperations(program.opts());
    try {
      const tools = operations.list(search);
      print({ count: tools.length, tools }, Boolean(program.opts().json));
    } finally { await operations.close(); }
  });
  program.command('describe <name>').description('Read one operation’s parameters, effects and guidance').action(async (name: string) => {
    const operations = assistantOperations(program.opts());
    try { print(operations.describe(name), Boolean(program.opts().json)); }
    finally { await operations.close(); }
  });
  program.command('call <name>').description('Run a named Ziggs operation over HTTPS; no host MCP connection needed')
    .option('--args <json>', 'JSON object of operation arguments')
    .option('--args-file <path>', 'Read JSON from a file, or - for stdin')
    .option('--read-only', 'Refuse operations that change state before making any request')
    .action(async (name: string, options) => {
      const args = await readArguments(options);
      const operations = assistantOperations(program.opts());
      try {
        const result = await operations.call(name, args, Boolean(options.readOnly));
        // Preserve rich content and refusal fields instead of flattening them
        // into a success-shaped value. Errors remain distinguishable to scripts.
        print(result, Boolean(program.opts().json));
        if ((result as { isError?: boolean })?.isError) process.exitCode = 1;
      } finally { await operations.close(); }
    });
}
