import type { Command } from 'commander';
import {
  CONTEXT_READ_VIA,
  ContextReadClient,
  parseVia,
} from '@ziggs-ai/api-client';
import type { ContextReadType } from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';

/** Which read a `via` is, when the caller did not pass `--type`. */
export function readTypeForVia(via: string, explicit?: string): ContextReadType {
  if (explicit) return explicit as ContextReadType;
  const parsed = parseVia(via);
  if (parsed?.kind === 'task') return 'tasks';
  if (parsed?.kind === 'agreement') return 'agreements';
  if (parsed?.kind === 'artifact') return 'artifacts';
  return 'messages';
}

export function readTypeError(via: string, type: ContextReadType): string | null {
  const parsed = parseVia(via);
  if (!parsed) return null;
  if (CONTEXT_READ_VIA[type].includes(parsed.kind)) return null;
  const fits = (Object.keys(CONTEXT_READ_VIA) as ContextReadType[])
    .filter((candidate) => CONTEXT_READ_VIA[candidate].includes(parsed.kind));
  return `${via} is not a ${type} read. Pass --type ${fits.join(' or ')}.`;
}

export function registerReadCommand(program: Command): void {
  program
    .command('read <via>')
    .description(
      'Read context for a scope entry point (e.g. chat:abc, agreement:xyz, task:id)',
    )
    .option(
      '--type <type>',
      'Resource type: messages, artifacts, agreements, tasks. Omitted, it follows the via (task: reads tasks).',
    )
    .option('--after <iso>', 'ISO timestamp for forward-delta reads')
    .option('--cursor <cursor>', 'Opaque pagination cursor from prior nextCursor')
    .option('--limit <n>', 'Page size', parseInt)
    .option('--state <state>', 'Task state filter (tasks only)')
    .option('--grant <grantId>', 'Pin a specific context grant')
    .action(async (via: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const type = readTypeForVia(via, opts.type as string | undefined);
        const mismatch = readTypeError(via, type);
        if (mismatch) throw new Error(mismatch);
        const client = new ContextReadClient(creds.operatorKey, creds.agentId);
        const result = await client.read(type, {
          via,
          after: opts.after,
          cursor: opts.cursor,
          limit: opts.limit,
          state: opts.state,
          contextGrantId: opts.grant,
          direction: opts.after ? 'forward' : undefined,
        });
        print(result, json);
      } catch (err) {
        handleError(err, json);
      }
    });
}
