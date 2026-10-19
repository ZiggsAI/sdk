import type { Command } from 'commander';
import {
  GrantsClient,
  ContextReadClient,
  CONTEXT_GRANT_SCOPE_KINDS,
} from '@ziggs-ai/api-client';
import type { ContextSnapshotResult } from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';

export function formatSnapshot(snapshot: ContextSnapshotResult): string {
  const people = [
    ...(snapshot.users ?? []).map((user) => `${user.userId}${user.isYou ? ' (you)' : ''}`),
    ...(snapshot.agents ?? []).map((agent) => `${agent.agentId} (agent)`),
  ];
  const lines = [
    `History: ${snapshot.history?.length ?? 0}`,
    `People: ${people.join(', ') || 'none'}`,
  ];
  const agreements = snapshot.agreements ?? [];
  lines.push(`Agreements: ${agreements.length}`);
  for (const row of agreements.slice(0, 8)) {
    const agreement = row as { agreementId?: string; proposalStatus?: string; description?: string };
    const description = (agreement.description ?? '').replace(/\s+/g, ' ').slice(0, 80);
    lines.push(`  ${agreement.agreementId ?? '?'}  ${agreement.proposalStatus ?? ''}${description ? `  ${description}` : ''}`);
  }
  const artifacts = snapshot.artifacts?.items ?? [];
  if (artifacts.length > 0) {
    lines.push(`Artifacts: ${artifacts.length}`);
    for (const artifact of artifacts.slice(0, 8)) {
      lines.push(`  ${artifact.artifactId}  ${artifact.name ?? artifact.contentType}`);
    }
  }
  return lines.join('\n');
}

export function registerContextCommands(program: Command): void {
  const context = program
    .command('context')
    .description('Context discovery');

  context
    .command('discover')
    .description('List all scope descriptors this delegate can reach (grants only, no content)')
    .action(async () => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new GrantsClient(creds.operatorKey, creds.agentId);
        const reach = await client.listAllGrants({
          // Every context scope, from the canonical list — a hand-written subset
          // still typechecks and silently drops whatever was added since.
          scopeKind: [...CONTEXT_GRANT_SCOPE_KINDS],
          health: 'active',
        });
        if (json) {
          print({ count: reach.length, reach }, true);
          return;
        }
        if (reach.length === 0) {
          console.log('No reachable scopes found.');
          return;
        }
        console.log(`${reach.length} reachable scope(s):`);
        for (const r of reach) {
          console.log(`  ${JSON.stringify(r)}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  // ziggs snapshot <chatId> — top-level convenience alias
  program
    .command('snapshot <chatId>')
    .description('One-shot chat orientation: history, agreements (with *IsYou), and roster — grant-fenced')
    .option('--max-messages <n>', 'Cap message history')
    .action(async (chatId: string, opts: { maxMessages?: string }) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new ContextReadClient(creds.operatorKey, creds.agentId);
        const result = await client.snapshot(chatId.replace(/^chat:/, ''), {
          maxMessages: opts.maxMessages != null ? Number(opts.maxMessages) : undefined,
        });
        if (json) print(result, true);
        else console.log(formatSnapshot(result));
      } catch (err) {
        handleError(err, json);
      }
    });
}
