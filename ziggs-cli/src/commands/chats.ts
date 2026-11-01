import { parseMessageCommand } from '@ziggs-ai/contracts';
import type { Command } from 'commander';
import {
  listMyChats,
  openConversation,
  MessageRecordsClient,
  ArtifactsClient,
  ContextReadClient,
  ContextGrantsClient,
} from '@ziggs-ai/api-client';
import type { ArtifactVisibility } from '@ziggs-ai/api-client';
import type { ChatSummary } from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';

export function formatChatLine(chat: ChatSummary): string {
  const name = chat.name?.trim() || chat.addressId;
  const unread = chat.unreadCount ? `  unread ${chat.unreadCount}` : '';
  const snippet = chat.lastMessage?.snippet ? `  ${chat.lastMessage.snippet}` : '';
  return `  ${name}  ${chat.addressId}${unread}${snippet}`;
}

export function registerChatsCommands(program: Command): void {
  // ziggs chats
  program
    .command('chats')
    .description('List chats the delegate agent is a member of')
    .action(async () => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const chats = await listMyChats(creds);
        if (json) {
          print({ count: chats.length, chats }, true);
          return;
        }
        if (chats.length === 0) {
          console.log('No chats found.');
          return;
        }
        console.log(`${chats.length} chat(s):`);
        for (const c of chats) console.log(formatChatLine(c));
      } catch (err) {
        handleError(err, json);
      }
    });

  // ziggs open <participantId>
  program
    .command('open <participantId>')
    .description('Open or reuse a chat with a participant (user or agent id)')
    .action(async (participantId: string) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const result = await openConversation(participantId, creds);
        if (json) {
          print(result, true);
        } else {
          console.log(`Chat opened: ${result.addressId}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  program
    .command('messages')
    .description('Query authorized messages; filters never select sending authority')
    .option('--participants <ids>', 'Comma-separated explicit principal IDs')
    .option('--agreement <id>', 'Agreement history filter')
    .option('--task <id>', 'Task history filter')
    .option('--before <cursor>', 'Opaque continuation cursor from a previous response')
    .option('--limit <n>', 'Maximum page size', Number)
    .action(async (opts) => {
      const json = Boolean(program.opts().json);
      const creds = loadCreds();
      try {
        const client = new MessageRecordsClient(creds.operatorKey, creds.agentId);
        print(await client.list({ participantIds: opts.participants?.split(','), agreementId: opts.agreement,
          taskId: opts.task, before: opts.before, limit: opts.limit }), json);
      } catch (err) { handleError(err, json); }
    });

  program
    .command('send <commandJson>')
    .description('Send a MessageCommand JSON object with operationId, content, audience, deliveries and effect; reuse the exact command on retry')
    .action(async (commandJson: string) => {
      const json = Boolean(program.opts().json);
      const creds = loadCreds();
      try {
        const command = parseMessageCommand(JSON.parse(commandJson));
        const client = new MessageRecordsClient(creds.operatorKey, creds.agentId);
        print(await client.send(command), json);
      } catch (err) { handleError(err, json); }
    });

  // ziggs artifact record
  const artifact = program
    .command('artifact')
    .description('Artifact operations');

  artifact
    .command('record')
    .description('Write an artifact to a chat or agreement scope')
    .requiredOption('--text <text>', 'Artifact body')
    .requiredOption(
      '--visibility <v>',
      'chat (visible to scope parties) or agent-private',
    )
    .option('--chat <addressId>', 'Target chat (xor --agreement)')
    .option('--agreement <agreementId>', 'Target agreement (xor --chat)')
    .option('--task <taskId>', 'Optional task link')
    .option('--content-type <type>', 'Content type (default: text)', 'text')
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      if ((opts.chat && opts.agreement) || (!opts.chat && !opts.agreement)) {
        console.error('Error: pass exactly one of --chat or --agreement');
        process.exit(1);
      }
      try {
        const client = new ArtifactsClient(creds.operatorKey, creds.agentId);
        await client.write({
          text: opts.text as string,
          visibility: opts.visibility as ArtifactVisibility,
          addressId: opts.chat as string | undefined,
          agreementId: opts.agreement as string | undefined,
          taskId: opts.task as string | undefined,
          contentType: opts.contentType as string,
        });
        if (json) {
          print({ ok: true }, true);
        } else {
          console.log(`Artifact recorded.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  artifact
    .command('list')
    .description('List artifacts in one chat, agreement, or task')
    .option('--chat <addressId>')
    .option('--agreement <agreementId>')
    .option('--task <taskId>')
    .option('--limit <n>', 'Max rows', parseInt)
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new ArtifactsClient(creds.operatorKey, creds.agentId);
        const result = await client.list(
          {
            addressId: opts.chat as string | undefined,
            agreementId: opts.agreement as string | undefined,
            taskId: opts.task as string | undefined,
          },
          { limit: opts.limit as number | undefined },
        );
        print(result, json);
      } catch (err) {
        handleError(err, json);
      }
    });

  artifact
    .command('read <artifactId>')
    .description('Read one artifact')
    .action(async (artifactId: string) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new ContextReadClient(creds.operatorKey, creds.agentId);
        const result = await client.read('artifacts', { via: `artifact:${artifactId}` });
        print(result, json);
      } catch (err) {
        handleError(err, json);
      }
    });

  artifact
    .command('download <artifactId>')
    .description('Get a download URL for an artifact file')
    .action(async (artifactId: string) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new ArtifactsClient(creds.operatorKey, creds.agentId);
        const result = await client.download(artifactId);
        if (json) print(result, true);
        else console.log(`${result.filename}\n${result.downloadUrl}`);
      } catch (err) {
        handleError(err, json);
      }
    });

  artifact
    .command('share <artifactId>')
    .description('Share an artifact you authored with one agent')
    .requiredOption('--to <agentId>', 'Agent that receives it')
    .action(async (artifactId: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new ContextGrantsClient(creds.operatorKey, creds.agentId);
        const result = await client.shareArtifact(artifactId, { holderId: opts.to as string });
        if (json) print(result, true);
        else console.log(`Shared ${artifactId} with ${opts.to as string}`);
      } catch (err) {
        handleError(err, json);
      }
    });
}
