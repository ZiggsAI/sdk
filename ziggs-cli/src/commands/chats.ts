import { parseMessageCommand } from '@ziggs-ai/contracts';
import type { Command } from 'commander';
import {
  MessageRecordsClient,
  ArtifactsClient,
  ContextReadClient,
} from '@ziggs-ai/api-client';
import type { ArtifactVisibility } from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';

export function registerChatsCommands(program: Command): void {
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
    .description('Send a MessageCommand JSON object with operationId, content, audience, deliveries and intent (fyi or request); reuse the exact command on retry')
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
    .description('Write an artifact, optionally under explicit work')
    .requiredOption('--text <text>', 'Artifact body')
    .requiredOption(
      '--visibility <v>',
      'address (authorized work readers) or agent-private',
    )
    .option('--agreement <agreementId>', 'Explicit agreement')
    .option('--task <taskId>', 'Optional task link')
    .option('--content-type <type>', 'Content type (default: text)', 'text')
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new ArtifactsClient(creds.operatorKey, creds.agentId);
        await client.write({
          text: opts.text as string,
          visibility: opts.visibility as ArtifactVisibility,
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
    .description('List artifacts under an agreement or task')
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
}
