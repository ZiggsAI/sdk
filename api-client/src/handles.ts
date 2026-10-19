/**
 * Short handles: the id of a task (T…), agreement (A…), chat (C…) or
 * artifact (F…). A kind letter, five to eight letters from 0-9 A-Z without
 * I, L, O and U, and a check letter. Read in any case; written upper case.
 *
 * Mirrors the server's rule so a mistyped handle is refused here, before any
 * call. The server stays the judge of what the handle opens.
 */

export const HANDLE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type HandleKind = 'task' | 'agreement' | 'chat' | 'artifact';

const LETTER_KIND: Record<string, HandleKind> = { T: 'task', A: 'agreement', C: 'chat', F: 'artifact' };
const N = HANDLE_ALPHABET.length;

function checkHolds(handle: string): boolean {
  let factor = 1;
  let sum = 0;
  for (let i = handle.length - 1; i >= 0; i--) {
    let addend = factor * HANDLE_ALPHABET.indexOf(handle[i]);
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return sum % N === 0;
}

/** The handle's kind and its upper-case form, or null when it is not one. */
export function parseHandle(raw: string): { kind: HandleKind; id: string } | null {
  const handle = raw.trim().toUpperCase();
  if (handle.length < 7 || handle.length > 10) return null;
  if (![...handle].every((c) => HANDLE_ALPHABET.includes(c))) return null;
  const kind = LETTER_KIND[handle[0]];
  if (!kind || !checkHolds(handle)) return null;
  return { kind, id: handle };
}

const OLD_SHAPES: Array<[RegExp, HandleKind]> = [
  [/^task_[0-9a-f-]{36}$/, 'task'],
  [/^agr_[A-Za-z0-9_]+$/, 'agreement'],
  [/^(art_|org-state-)[A-Za-z0-9_-]+$/, 'artifact'],
  [/^[a-z]{24}$/, 'chat'],
];

/** The shape of a handle, whether or not its check letter holds. */
export function looksLikeHandle(raw: string): boolean {
  return /^[TACF][0-9A-Z]{6,9}$/i.test(raw.trim());
}

function parseOne(token: string): { kind: HandleKind; id: string } | null {
  const trimmed = token.trim();
  for (const [shape, kind] of OLD_SHAPES) if (shape.test(trimmed)) return { kind, id: trimmed };
  return parseHandle(trimmed);
}

/**
 * What a `ref` names: a handle in any case, a Ziggs web URL that contains
 * one, or an id of the older shape. Null when it names nothing.
 */
export function parseRef(raw: unknown): { kind: HandleKind; id: string } | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  const direct = parseOne(value);
  if (direct) return direct;
  if (!/[/?#]/.test(value)) return null;
  let path = value;
  try {
    const url = new URL(value, 'https://ziggsai.com');
    path = `${url.pathname}/${[...url.searchParams.values()].join('/')}`;
  } catch {
    // Not a URL; split what was given.
  }
  for (const segment of path.split(/[/?#&=]/).reverse()) {
    if (!segment) continue;
    const hit = parseOne(decodeURIComponent(segment));
    if (hit) return hit;
  }
  return null;
}

const CANDIDATE = /\b[TACF][0-9A-HJKMNP-TV-Z]{6,9}\b/gi;

/**
 * Every handle named in free text, in order and once each, so an agent that
 * reads "look at T7K2QXD" can open it without anyone pasting a form. Words
 * that merely look like one fail the check letter and are left out.
 */
export function findHandles(text: string): Array<{ kind: HandleKind; id: string }> {
  const out: Array<{ kind: HandleKind; id: string }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(CANDIDATE)) {
    const hit = parseHandle(match[0]);
    if (hit && !seen.has(hit.id)) {
      seen.add(hit.id);
      out.push(hit);
    }
  }
  return out;
}
