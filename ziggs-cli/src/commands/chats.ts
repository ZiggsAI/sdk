import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import {
  listMyChats,
  openConversation,
  sendChatMessage,
  MessagesClient,
  ArtifactsClient,
  ContextReadClient,
  ContextGrantsClient,
} from '@ziggs-ai/api-client';
import type { ArtifactVisibility } from '@ziggs-ai/api-client';
import type { ChatSummary } from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';

/** Newest page unless the caller already has a timestamp to continue from. */
export function messagesRequest(opts: { after?: string; limit?: number }): {
  latest: boolean;
  after?: string;
  limit: number;
} {
  if (opts.after) return { latest: false, after: opts.after, limit: opts.limit ?? 100 };
  return { latest: true, limit: opts.limit ?? 20 };
}

export function formatChatLine(chat: ChatSummary): string {
  const name = chat.name?.trim() || chat.chatId;
  const unread = chat.unreadCount ? `  unread ${chat.unreadCount}` : '';
  const snippet = chat.lastMessage?.snippet ? `  ${chat.lastMessage.snippet}` : '';
  return `  ${name}  ${chat.chatId}${unread}${snippet}`;
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
          console.log(`Chat opened: ${result.chatId}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  // ziggs messages <chatId>
  program
    .command('messages <chatId>')
    .description('List the latest messages in a chat. Pass --after to continue forward from a timestamp.')
    .option('--after <iso>', 'ISO timestamp; only messages after it')
    .option('--limit <n>', 'Max messages (default 20, or 100 with --after)', parseInt)
    .action(async (chatId: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new MessagesClient(creds.operatorKey, creds.agentId);
        const req = messagesRequest({ after: opts.after, limit: opts.limit });
        const result = req.latest
          ? await client.listLatest(chatId, { limit: req.limit })
          : await client.list(chatId, { after: req.after, limit: req.limit });
        print(result, json);
      } catch (err) {
        handleError(err, json);
      }
    });

  // ziggs send <chatId> <text> --to <receiverId>
  program
    .command('send <chatId> <text>')
    .description('Send a message to a chat')
    .requiredOption('--to <receiverId>', 'Recipient user or agent id')
    .option('--entry-type <type>', 'Entry type (default: message)', 'message')
    .action(async (chatId: string, text: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const result = await sendChatMessage(
          {
            chatId,
            receiverId: opts.to as string,
            text,
            messageId: `cli_${randomUUID()}`,
            entryType: opts.entryType as string,
            contentType: 'text',
          },
          creds,
        );
        if (json) {
          print(result, true);
        } else {
          console.log(`Message sent: ${result.messageId}`);
        }
      } catch (err) {
        handleError(err, json);
      }
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
    .option('--chat <chatId>', 'Target chat (xor --agreement)')
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
          chatId: opts.chat as string | undefined,
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
    .option('--chat <chatId>')
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
            chatId: opts.chat as string | undefined,
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
