import type { Command } from 'commander';
import {
  GrantsClient,
  ContextGrantsClient,
  grantCaveat,
  CONTEXT_GRANT_SCOPE_KINDS,
} from '@ziggs-ai/api-client';
import type {
  ContextGrantScopeKind,
  ContextTemporal,
  GrantAccessKind,
  GrantHolderKind,
} from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';

function parseScope(raw: string): { kind: ContextGrantScopeKind; id: string } {
  const idx = raw.indexOf(':');
  if (idx < 0) throw new Error(`Invalid scope "${raw}" — expected kind:id`);
  return {
    kind: raw.slice(0, idx) as ContextGrantScopeKind,
    id: raw.slice(idx + 1),
  };
}

export function registerGrantsCommands(program: Command): void {
  const grants = program
    .command('grants')
    .description('Context grant management');

  grants
    .command('list')
    .description('List context grants held by this agent (its reach)')
    .action(async () => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new GrantsClient(creds.operatorKey, creds.agentId);
        const list = await client.listAllGrants({
          // Every context scope, from the canonical list — a hand-written subset
          // still typechecks and silently drops whatever was added since.
          scopeKind: [...CONTEXT_GRANT_SCOPE_KINDS],
          health: 'active',
        });
        if (json) {
          print({ count: list.length, grants: list }, true);
          return;
        }
        if (list.length === 0) {
          console.log('No grants found.');
          return;
        }
        console.log(`${list.length} grant(s):`);
        for (const g of list) {
          const expires = g.expiresAt ? `  expires: ${g.expiresAt}` : '';
          console.log(
            `  ${g.grantId}  ${g.scope.kind}:${g.scope.id}  temporal: ${grantCaveat(g, 'temporal')}${expires}`,
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  grants
    .command('issue')
    .description('Issue a context grant')
    .requiredOption('--holder <holderId>', 'Recipient id')
    .option(
      '--holder-kind <kind>',
      'What the holder is: user, org or agent (default: agent)',
      'agent',
    )
    .option('--access <kind>', 'read, write or admit (default: write)')
    .requiredOption('--scope <scope>', 'Scope as kind:id (e.g. chat:abc123)')
    .option('--temporal <t>', 'from-now or from-start (default: from-now)', 'from-now')
    .option('--expires <iso>', 'Expiry ISO timestamp')
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new ContextGrantsClient(creds.operatorKey, creds.agentId);
        const grant = await client.issueGrant({
          holderId: opts.holder as string,
          holderKind: opts.holderKind as GrantHolderKind,
          kind: opts.access as GrantAccessKind | undefined,
          scope: parseScope(opts.scope as string),
          temporal: opts.temporal as ContextTemporal,
          expiresAt: opts.expires as string | undefined,
        });
        if (json) {
          print(grant, true);
        } else {
          console.log(`Grant issued: ${grant.grantId}`);
          console.log(
            `  scope: ${grant.scope.kind}:${grant.scope.id}  temporal: ${grantCaveat(grant, 'temporal')}`,
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  grants
    .command('delegate <parentGrantId>')
    .description('Delegate an existing grant')
    .requiredOption('--holder <holderId>', 'Recipient id')
    .option(
      '--holder-kind <kind>',
      'What the holder is: user, org or agent (default: agent)',
      'agent',
    )
    .option('--access <kind>', 'read, write or admit (default: the parent\'s)')
    .requiredOption('--scope <scope>', 'Scope as kind:id')
    .requiredOption('--temporal <t>', 'from-now or from-start')
    .option('--expires <iso>', 'Expiry ISO timestamp')
    .action(async (parentGrantId: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new ContextGrantsClient(creds.operatorKey, creds.agentId);
        const result = await client.delegateGrant(parentGrantId, {
          holderId: opts.holder as string,
          holderKind: opts.holderKind as GrantHolderKind,
          kind: opts.access as GrantAccessKind | undefined,
          scope: parseScope(opts.scope as string),
          temporal: opts.temporal as ContextTemporal,
          expiresAt: opts.expires as string | undefined,
        });
        if (json) {
          print(result, true);
        } else if (result.status === 'pending_approval') {
          console.log(
            "Not granted yet — the grant's original owner must approve sharing it.",
          );
          console.log(`  request agreement: ${result.agreementId}`);
          if (result.ownerId) console.log(`  owner: ${result.ownerId}`);
        } else {
          const { grant } = result;
          console.log(`Grant delegated: ${grant.grantId}`);
          console.log(
            `  scope: ${grant.scope.kind}:${grant.scope.id}  temporal: ${grantCaveat(grant, 'temporal')}`,
          );
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  grants
    .command('revoke <grantId>')
    .description('Revoke a context grant')
    .action(async (grantId: string) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const client = new ContextGrantsClient(creds.operatorKey, creds.agentId);
        const result = await client.revokeGrant(grantId);
        if (json) {
          print(result, true);
        } else {
          console.log(`Grant ${grantId} revoked.`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });
}
