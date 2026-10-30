/**
 * ZIG-1390 / ZIG-2116 — what connecting to this server costs a caller, on the
 * wire, for each door.
 *
 *   npx tsx scripts/measure-surface.mts                 # both doors, plain
 *   npx tsx scripts/measure-surface.mts --door=directory
 *   npx tsx scripts/measure-surface.mts --json
 *   npx tsx scripts/measure-surface.mts --check         # exit 1 over budget
 *
 * Two doors, two lists. The directory door (`directConnection: false`, the
 * OAuth connector ChatGPT, Claude and Cursor use) lists every operation as its
 * own tool. The compact door (operator-key clients) lists every operation
 * too, plus the catalog and its two dispatchers for clients that mount only
 * an allow-list.
 *
 * Two numbers matter and they are not the same number. The *price* of tool
 * definitions is mostly cache reads after the first turn, because they sit in
 * the cacheable prefix. The *window space* is gone either way, and a client may
 * not keep all of it: Claude Code keeps the first 2,048 characters of the
 * connect text and of each description; OpenAI advises the important details
 * in the first 512. The budgets below are those limits, so a change that pushes
 * a must-have rule past them fails here rather than in a client.
 */
import { pathToFileURL } from 'node:url';
import { captureSurface } from './lib/capture-surface.mts';

/** ~4 chars per token is the working rule for English + JSON schemas. */
const CHARS_PER_TOKEN = 4;

export type Door = 'directory' | 'compact';
export const DOORS: readonly Door[] = ['directory', 'compact'];

/**
 * The budgets. The connect text and each description are capped by what the
 * clients keep; the whole list by a ceiling set from the measurement that
 * shipped with it, so it can shrink freely and grows only by changing a
 * number someone has to review.
 */
export const BUDGET = {
  connectTextChars: 2_000,
  descriptionChars: 250,
  // compact 17,000 -> 86,000: the compact door lists every operation. Measured
  // with headless Claude Code, listing everything cost the same or less per
  // task than the everyday set plus the catalog, because a rare tool no longer
  // needs a catalog call first.
  // directory 92,000 -> 93,000: counter carries the shared interface and allowance.
  // compact 86,000 -> 87,500: ziggs_session_list / ziggs_session_hold.
  // Execution context selection on each operation adds ~3k schema characters.
  // The instructions are carried once in the inbox, not repeated per tool.
  listChars: { directory: 93_000, compact: 91_000 } as Record<Door, number>,
} as const;

export function approxTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

export interface DoorMeasurement {
  door: Door;
  connectText: { chars: number; approxTokens: number; text: string };
  tools: number;
  onConnect: {
    chars: number;
    approxTokens: number;
    names: number;
    descriptions: number;
    schemas: number;
    parameterDescriptions: number;
  };
  descriptions: {
    median: number;
    max: number;
    overCap: Array<{ name: string; chars: number }>;
  };
  /** Parameter descriptions written out on more than one tool. */
  repeatedParameters: {
    texts: number;
    chars: number;
    top: Array<{ chars: number; tools: number; text: string }>;
  };
  /** Compact door only: what the catalog saves over listing everything. */
  catalog?: { tools: number; ifEverythingWereListed: number };
}

export async function measureDoor(door: Door): Promise<DoorMeasurement> {
  const surface = await captureSurface({ directConnection: door === 'compact', coreOnly: false, debugTools: false });
  const text = surface.instructions;
  const { tools } = surface;

  let names = 0;
  let descriptions = 0;
  let schemas = 0;
  let parameterDescriptions = 0;
  const lengths: number[] = [];
  const overCap: Array<{ name: string; chars: number }> = [];
  const paramUses = new Map<string, number>();
  for (const t of tools) {
    const d = t.description?.length ?? 0;
    names += t.name.length + (t.title?.length ?? 0);
    descriptions += d;
    lengths.push(d);
    if (d > BUDGET.descriptionChars) overCap.push({ name: t.name, chars: d });
    schemas += JSON.stringify(t.inputSchema ?? {}).length;
    const props = (t.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties ?? {};
    for (const p of Object.values(props)) {
      const pd = p.description ?? '';
      parameterDescriptions += pd.length;
      if (pd) paramUses.set(pd, (paramUses.get(pd) ?? 0) + 1);
    }
  }

  const repeated = [...paramUses]
    .filter(([, n]) => n > 1)
    .map(([t, n]) => ({ chars: t.length * n, tools: n, text: t }))
    .sort((a, b) => b.chars - a.chars);
  const listed = JSON.stringify(tools).length;

  let catalog: DoorMeasurement['catalog'];
  if (door === 'compact') {
    // Only the entries that are NOT already listed: a natively listed tool
    // stays in the catalog, so adding every entry would count it twice.
    const nativelyListed = new Set(tools.map((t) => t.name));
    const entries = surface.catalog;
    // A catalog-only tool is read through `ziggs_tools describe`, so its
    // description is held to the same cap as a listed one.
    for (const e of entries) {
      if (nativelyListed.has(e.name)) continue;
      const d = String(e.description ?? '').length;
      if (d > BUDGET.descriptionChars) overCap.push({ name: e.name, chars: d });
    }
    catalog = {
      tools: entries.length,
      ifEverythingWereListed:
        listed +
        entries
          .filter((e) => !nativelyListed.has(e.name))
          .reduce((n, e) => n + JSON.stringify(e).length, 0),
    };
  }

  lengths.sort((a, b) => a - b);
  return {
    door,
    connectText: { chars: text.length, approxTokens: approxTokens(text.length), text },
    tools: tools.length,
    onConnect: {
      chars: listed,
      approxTokens: approxTokens(listed),
      names,
      descriptions,
      schemas,
      parameterDescriptions,
    },
    descriptions: {
      median: lengths[lengths.length >> 1] ?? 0,
      max: lengths.at(-1) ?? 0,
      overCap: overCap.sort((a, b) => b.chars - a.chars),
    },
    repeatedParameters: {
      texts: repeated.length,
      chars: repeated.reduce((n, r) => n + r.chars, 0),
      top: repeated.slice(0, 5),
    },
    ...(catalog ? { catalog } : {}),
  };
}

/** Every way a door is over budget, one line each. Empty means it fits. */
export function overBudget(m: DoorMeasurement): string[] {
  const out: string[] = [];
  if (m.connectText.chars > BUDGET.connectTextChars)
    out.push(
      `${m.door}: connect text is ${m.connectText.chars} chars (budget ${BUDGET.connectTextChars})`,
    );
  for (const t of m.descriptions.overCap)
    out.push(
      `${m.door}: ${t.name} description is ${t.chars} chars (budget ${BUDGET.descriptionChars})`,
    );
  if (m.onConnect.chars > BUDGET.listChars[m.door])
    out.push(
      `${m.door}: tool list is ${m.onConnect.chars} chars (budget ${BUDGET.listChars[m.door]})`,
    );
  return out;
}

function print(m: DoorMeasurement): void {
  const n = (x: number) => x.toLocaleString();
  console.log(`${m.door} door`);
  console.log(`  connect text      ${n(m.connectText.chars)} chars  ~${n(m.connectText.approxTokens)} tokens`);
  console.log(`  tools listed      ${m.tools}`);
  console.log(`  on connect        ${n(m.onConnect.chars)} chars  ~${n(m.onConnect.approxTokens)} tokens`);
  console.log(`    names+titles    ${n(m.onConnect.names)} chars`);
  console.log(`    descriptions    ${n(m.onConnect.descriptions)} chars  (median ${m.descriptions.median}, max ${m.descriptions.max}, ${m.descriptions.overCap.length} over ${BUDGET.descriptionChars})`);
  console.log(`    input schemas   ${n(m.onConnect.schemas)} chars  (parameter text ${n(m.onConnect.parameterDescriptions)})`);
  console.log(`  repeated params   ${m.repeatedParameters.texts} texts, ${n(m.repeatedParameters.chars)} chars`);
  for (const r of m.repeatedParameters.top)
    console.log(`    ${r.tools}× ${r.text.slice(0, 70)}${r.text.length > 70 ? '…' : ''}`);
  if (m.catalog)
    console.log(`  catalog           ${m.catalog.tools} tools; listing all would be ${n(m.catalog.ifEverythingWereListed)} chars`);
  console.log('');
}

async function main(): Promise<void> {
  const doorFlag = process.argv.find((a) => a.startsWith('--door='))?.slice(7);
  const doors = doorFlag ? [doorFlag as Door] : DOORS;
  const results = [];
  for (const door of doors) results.push(await measureDoor(door));
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        results.map(({ connectText: { text: _text, ...c }, ...m }) => ({ ...m, connectText: c })),
        null,
        2,
      ),
    );
  } else {
    for (const m of results) print(m);
  }
  if (process.argv.includes('--check')) {
    const over = results.flatMap(overBudget);
    for (const line of over) console.error(`over budget: ${line}`);
    if (over.length) process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
