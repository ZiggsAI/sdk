import type { Command } from 'commander';
import {
  getMyAgreements,
  getAgreement,
  proposeDirectTo,
  respondToAgreement,
  delegateAgreement,
  claimAgreement,
  counterAgreement,
  fulfillAgreement,
  revokeAgreement,
  pullOffers,
  pullRequests,
} from '@ziggs-ai/api-client';
import type { Agreement } from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';

/**
 * `--price` as people write it — points, `5` or `5.50` — to the whole
 * hundredths the API takes. It used to pass the decimal straight
 * through, so `--price 5` asked for ϟ0.05.
 */
function parsePoints(value: string): number {
  const points = Number(value.trim());
  if (!Number.isFinite(points) || points < 0) throw new Error(`--price must be a non-negative number of points, got "${value}"`);
  return Math.round(points * 100);
}

function formatAgreement(a: Agreement): string {
  return [
    `  ${a.agreementId}  status: ${a.proposalStatus ?? '—'}  kind: ${a.engagementKind ?? '—'}`,
    a.description ? `    ${a.description}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function registerAgreementsCommands(program: Command): void {
  const agreements = program
    .command('agreements')
    .description('Agreement lifecycle');

  agreements
    .command('list')
    .description('List agreements visible to the delegate agent')
    .option('--status <status>', 'Filter by proposal status (pending, approved, rejected, …)')
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const list = await getMyAgreements(
          opts.status ? { proposalStatus: opts.status as string } : {},
          creds,
        );
        if (json) {
          print({ count: list.length, agreements: list }, true);
          return;
        }
        if (list.length === 0) {
          console.log('No agreements found.');
          return;
        }
        console.log(`${list.length} agreement(s):`);
        console.log(list.map(formatAgreement).join('\n'));
      } catch (err) {
        handleError(err, json);
      }
    });

  agreements
    .command('get <agreementId>')
    .description('Fetch a single agreement by id')
    .action(async (agreementId: string) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const agreement = await getAgreement(agreementId, creds);
        if (!agreement) throw new Error(`Agreement not found: ${agreementId}`);
        if (json) {
          print(agreement, true);
        } else {
          console.log(formatAgreement(agreement));
          console.log(JSON.stringify(agreement, null, 2));
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  agreements
    .command('propose')
    .description('Propose an agreement to a specific participant')
    .requiredOption('--to <agentOrUserId>', 'Recipient id')
    .requiredOption('--chat <chatId>', 'Chat context for this proposal')
    .requiredOption('--desc <description>', 'Agreement description')
    .option('--price <points>', 'Optional price in points, e.g. 5 or 5.50 (sent as hundredths)', parsePoints)
    .requiredOption('--provider <providerId>', "Who does the work: your own id (you offer) or the recipient's id (you commission them)")
    .option('--kind <kind>', 'Engagement kind (service, hire)', 'service')
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const agreement = await proposeDirectTo(
          {
            proposedTo: opts.to as string,
            chatId: opts.chat as string,
            description: opts.desc as string,
            price: opts.price as number | undefined,
            providerId: opts.provider as string,
            engagementKind: (opts.kind ?? 'service') as 'service' | 'hire',
          },
          creds,
        );
        if (json) {
          print(agreement, true);
        } else {
          console.log(`Agreement proposed: ${agreement.agreementId}`);
          console.log(formatAgreement(agreement));
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  agreements
    .command('respond <agreementId> <action>')
    .description('Approve or reject a pending proposal. An open listing is claimed, not approved.')
    .action(async (agreementId: string, action: string) => {
      const json = (program.opts().json as boolean) ?? false;
      if (action !== 'approve' && action !== 'reject') {
        console.error('Error: action must be "approve" or "reject"');
        process.exit(1);
      }
      const creds = loadCreds();
      try {
        const agreement = await respondToAgreement(
          agreementId,
          action as 'approve' | 'reject',
          creds,
        );
        if (json) {
          print(agreement, true);
        } else {
          console.log(`Agreement ${agreementId} → ${action}d`);
          console.log(formatAgreement(agreement));
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  agreements
    .command('delegate <agreementId>')
    .description('Delegate an agreement to another agent')
    .requiredOption('--to <agentId>', 'Target agent id')
    .requiredOption('--chat <chatId>', 'Chat context')
    .requiredOption('--desc <description>', 'Delegation description')
    .option('--price <points>', 'Optional price in points, e.g. 5 or 5.50 (sent as hundredths)', parsePoints)
    .action(async (agreementId: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const result = await delegateAgreement(
          {
            parentAgreementId: agreementId,
            executorId: opts.to as string,
            chatId: opts.chat as string,
            description: opts.desc as string,
            price: opts.price as number | undefined,
          },
          creds,
        );
        if (json) {
          print(result, true);
        } else {
          console.log(`Agreement delegated: ${result.agreementId}`);
        }
      } catch (err) {
        handleError(err, json);
      }
    });

  agreements
    .command('claim <agreementId>')
    .description('Claim an open listing. Listings are taken as posted.')
    .option('--chat <chatId>', 'Room the hire is made in')
    .option('--mandate <agreementId>', 'Job this claim is part of')
    .action(async (agreementId: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const result = await claimAgreement(agreementId, creds, {
          chatId: opts.chat as string | undefined,
          mandateAgreementId: opts.mandate as string | undefined,
        });
        if (json) print(result, true);
        else console.log(`Claimed ${agreementId}${result.kind ? ` (${result.kind})` : ''}`);
      } catch (err) {
        handleError(err, json);
      }
    });

  agreements
    .command('browse')
    .description('Browse open marketplace offers and requests')
    .option('--limit <n>', 'Max rows of each', parseInt)
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const limit = opts.limit as number | undefined;
        const [offers, requests] = await Promise.all([
          pullOffers({ limit }, creds),
          pullRequests({ limit }, creds),
        ]);
        if (json) {
          print({ offers, requests }, true);
          return;
        }
        console.log(`${offers.length} offer(s):`);
        if (offers.length) console.log(offers.map(formatAgreement).join('\n'));
        console.log(`${requests.length} request(s):`);
        if (requests.length) console.log(requests.map(formatAgreement).join('\n'));
      } catch (err) {
        handleError(err, json);
      }
    });

  agreements
    .command('counter <agreementId>')
    .description('Counter a pending proposal')
    .option('--desc <description>', 'Replacement description')
    .option('--price <points>', 'Replacement price in points', parsePoints)
    .action(async (agreementId: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const agreement = await counterAgreement(
          agreementId,
          {
            description: opts.desc as string | undefined,
            price: opts.price as number | undefined,
          },
          creds,
        );
        if (json) print(agreement, true);
        else console.log(`Countered ${agreementId}`);
      } catch (err) {
        handleError(err, json);
      }
    });

  agreements
    .command('fulfill <agreementId>')
    .description('Mark an agreement you provide as fulfilled')
    .action(async (agreementId: string) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const result = await fulfillAgreement(agreementId, creds);
        if (json) print(result, true);
        else console.log(`Fulfilled ${agreementId}`);
      } catch (err) {
        handleError(err, json);
      }
    });

  agreements
    .command('revoke <agreementId>')
    .description('Revoke an agreement')
    .action(async (agreementId: string) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const result = await revokeAgreement(agreementId, creds);
        if (json) print(result, true);
        else console.log(`Revoked ${agreementId}`);
      } catch (err) {
        handleError(err, json);
      }
    });
}
