import type { Command } from 'commander';
import { InboxClient } from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';
import type { InboxEnvelope } from '@ziggs-ai/api-client';

export function formatInbox(envelope: InboxEnvelope): string {
  const lines: string[] = [];
  lines.push(`Inbox as of ${envelope.asOf}`);

  if (envelope.humanAttention) {
    lines.push('');
    lines.push(`!! HUMAN ATTENTION REQUIRED: ${envelope.humanAttention.promptUser}`);
  }

  if (envelope.deliveries.length === 0) {
    lines.push('No new deliveries.');
  } else {
    lines.push(`\n${envelope.deliveries.length} deliver${envelope.deliveries.length === 1 ? 'y' : 'ies'} since last ack:`);
    for (const c of envelope.chats) {
      lines.push(`  chat:${c.chatId}  ${c.count} new  latest: ${c.latestAt}`);
    }
    for (const d of envelope.deliveries) {
      const ref = d.chatId ? `chat:${d.chatId}` : d.taskId ? `task:${d.taskId}` : d.agreementId ? `agreement:${d.agreementId}` : d.resourceId;
      lines.push(`  ${d.kind}  ${ref}  at: ${d.ts}`);
      if (d.responsibilityId) lines.push(`    responsibility: ${d.responsibilityId}`);
      if (d.executionContext) lines.push(`    execution: ${d.executionContext.contextId}`);
    }
  }

  if (envelope.tasksAwaitingMe.length > 0) {
    lines.push(`\n${envelope.tasksAwaitingMe.length} open task(s) assigned to you:`);
    for (const t of envelope.tasksAwaitingMe) {
      lines.push(`  ${t.taskId}  "${t.title}"  state: ${t.state}`);
    }
  }

  if (envelope.proposalsAwaitingMe.length > 0) {
    lines.push(`\n${envelope.proposalsAwaitingMe.length} proposal(s) awaiting response:`);
    for (const p of envelope.proposalsAwaitingMe) {
      lines.push(`  ${p.agreementId}  "${p.title}"  proposed: ${p.proposedAt ?? 'unknown'}`);
    }
  }

  if (envelope.deliveriesCapped) {
    lines.push('\n(more deliveries than one envelope carries — ack and fetch again for the tail)');
  }
  if (envelope.ackTo) {
    lines.push(`\nObserve through: --ack ${envelope.ackTo}`);
  }

  return lines.join('\n');
}

export function registerInboxCommand(program: Command): void {
  program
    .command('inbox')
    .description("What's addressed to you since last ack — references and counts, never content")
    .option(
      '--ack <upTo>',
      "Watermark to ack before fetching — pass the previous envelope's ackTo (opaque value). Observation does not finish assignments.",
    )
    .option(
      '--handled <responsibilityIds>',
      'Comma-separated responsibilityId values completed successfully. Failed or inaccessible assignments stay pending; never pass resource IDs.',
    )
    .option(
      '--wait [seconds]',
      'Block on GET /inbox/peek until assigned mail or timeout (default 110). Exit 0 if count>0, 1 on timeout. Does not take the inbox lease.',
    )
    .option(
      '--release',
      'Drop this process inbox host lease (DELETE /inbox/host) so the next client can take GET /inbox.',
    )
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new InboxClient(
          creds.operatorKey,
          creds.agentId,
          undefined,
          creds.instanceId,
          {
            clientSessionId: creds.clientSessionId,
            workspaceIds: creds.workspaceIds,
            app: creds.app,
            sessionName: creds.sessionName,
          },
        );

        if (opts.release) {
          const out = await client.releaseHost();
          if (json) {
            print(out, true);
          } else {
            console.log(
              out.released
                ? 'Inbox host released — the next client can take GET /inbox'
                : 'Inbox host was already free',
            );
          }
          return;
        }

        if (opts.wait !== undefined) {
          const waitSeconds =
            opts.wait === true || opts.wait === ''
              ? 110
              : Number(opts.wait);
          if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
            throw new Error('inbox --wait must be a non-negative number of seconds');
          }
          const peek = await client.peek({ waitSeconds });
          if (json) {
            print(peek, true);
          } else {
            console.log(
              peek.count > 0
                ? `Mail waiting (count=${peek.count}) as of ${peek.asOf}`
                : `No assigned mail as of ${peek.asOf}`,
            );
          }
          process.exitCode = peek.count > 0 ? 0 : 1;
          return;
        }

        if (opts.ack) {
          const handledDeliveryIds =
            typeof opts.handled === 'string' && opts.handled.length > 0
              ? (opts.handled as string)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : [];
          await client.ackOrTakeHost(opts.ack as string, { handledDeliveryIds });
        }

        const envelope = await client.getInbox();
        if (json) {
          print(envelope, true);
        } else {
          console.log(formatInbox(envelope));
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
