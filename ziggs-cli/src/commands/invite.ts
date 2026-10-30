import { hostname } from 'node:os';
import type { Command } from 'commander';
import {
  IntroductionsClient,
  type IntroductionView,
} from '@ziggs-ai/api-client';
import { loadCreds, resolveApiBase, tryLoadCreds } from '../creds.js';
import { clearStoredKey, credentialsPath, writeStoredKey } from '../keyStore.js';
import { handleError, print } from '../output.js';

const ABOUT_KINDS = ['agreement', 'task', 'chat'] as const;
type AboutKind = (typeof ABOUT_KINDS)[number];

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Accept a bare `zint_…` or the public page URL that embeds it. */
export function extractIntroductionToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('pass an introduction token (zint_…) or its link');
  if (/^zint_[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const parts = url.pathname.split('/').filter(Boolean);
    const introIdx = parts.findIndex((p) => p === 'intro' || p === 'i');
    if (introIdx >= 0 && parts[introIdx + 1]) {
      const candidate = parts[introIdx + 1]!;
      if (candidate.startsWith('zint_')) return candidate;
    }
    for (const part of parts) {
      if (part.startsWith('zint_')) return part;
    }
  } catch {
    // not a URL
  }
  if (trimmed.startsWith('zint_')) return trimmed;
  throw new Error('could not find a zint_… token in that string');
}

/** `--about chat:roomId` → kind + id. */
export function parseAbout(raw: string): { kind: AboutKind; id: string } {
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(':');
  if (colon <= 0) {
    throw new Error('--about must look like chat:<id>, task:<id>, or agreement:<id>');
  }
  const kind = trimmed.slice(0, colon).toLowerCase();
  const id = trimmed.slice(colon + 1).trim();
  if (!(ABOUT_KINDS as readonly string[]).includes(kind) || !id) {
    throw new Error('--about must look like chat:<id>, task:<id>, or agreement:<id>');
  }
  return { kind: kind as AboutKind, id };
}

interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
  client_id: string;
}

interface TokenOk {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

async function boardIntroduction(
  apiBase: string,
  token: string,
  clientName: string,
): Promise<DeviceStart> {
  const res = await fetch(
    `${apiBase}/introductions/${encodeURIComponent(token)}/board`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: clientName }),
    },
  );
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let message = text || `board failed: ${res.status}`;
    try {
      const body = JSON.parse(text) as { error?: string; message?: string };
      message = body.error || body.message || message;
    } catch {
      // keep text
    }
    throw new Error(message);
  }
  return JSON.parse(text) as DeviceStart;
}

async function pollDeviceToken(
  apiBase: string,
  started: DeviceStart,
): Promise<TokenOk> {
  const deadline = Date.now() + Math.max(1, started.expires_in) * 1000;
  let intervalMs = Math.max(1, started.interval) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const res = await fetch(`${apiBase}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: DEVICE_GRANT,
        device_code: started.device_code,
        client_id: started.client_id,
      }),
    });
    const text = await res.text().catch(() => '');
    if (res.ok) return JSON.parse(text) as TokenOk;
    let code = '';
    try {
      const body = JSON.parse(text) as { code?: string; error?: string };
      code = body.code || body.error || '';
    } catch {
      // ignore
    }
    if (code === 'authorization_pending') continue;
    if (code === 'slow_down') {
      intervalMs += 1000;
      continue;
    }
    if (code === 'access_denied') {
      throw new Error('the person declined this board request');
    }
    if (code === 'expired_token') {
      throw new Error('the board code expired; run join again');
    }
    throw new Error(text || `token poll failed: ${res.status}`);
  }
  throw new Error('the board code expired; run join again');
}

function nextStepLine(): string {
  return 'Next: ziggs inbox --wait';
}

function formatInviteHuman(intro: IntroductionView): string {
  const lines = [
    `token: ${intro.token}`,
    `url:   ${intro.url}`,
    `expires: ${intro.expiresAt}`,
  ];
  const redeems = intro.redeems;
  if (redeems) {
    lines.push(`redeems: ${redeems.allowed}`);
  }
  lines.push('', 'Hand over the url, or the token string alone.');
  return lines.join('\n');
}

function formatJoinHuman(payload: {
  outcome: string;
  message: string;
  storedKeyPath?: string;
}): string {
  const lines = [`outcome: ${payload.outcome}`, payload.message, nextStepLine()];
  if (payload.storedKeyPath) {
    lines.push(`key file: ${payload.storedKeyPath}`);
  }
  return lines.join('\n');
}

export function registerInviteCommands(program: Command): void {
  program
    .command('invite')
    .description('Mint an introduction string someone else can join with')
    .option('--about <kind:id>', 'chat:<id>, task:<id>, or agreement:<id> the redeem ends in')
    .option('--note <text>', 'one line the other side reads when they open it')
    .option('--redeems <n>', 'how many people it serves (1–25)', (v) => Number(v))
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      try {
        const creds = loadCreds();
        const about = opts.about ? parseAbout(String(opts.about)) : undefined;
        if (opts.redeems != null && (!Number.isFinite(opts.redeems) || opts.redeems < 1 || opts.redeems > 25)) {
          throw new Error('--redeems must be a number from 1 to 25');
        }
        const client = new IntroductionsClient(creds.operatorKey, creds.agentId || undefined);
        const intro = await client.mint({
          ...(opts.note ? { note: String(opts.note) } : {}),
          ...(about ? { about } : {}),
          ...(opts.redeems != null ? { redeems: Number(opts.redeems) } : {}),
        });
        if (json) {
          print(
            {
              token: intro.token,
              url: intro.url,
              expiresAt: intro.expiresAt,
              redeems: intro.redeems,
              introduction: intro,
            },
            true,
          );
          return;
        }
        console.log(formatInviteHuman(intro));
      } catch (err) {
        handleError(err, json);
      }
    });

  program
    .command('join')
    .description('Redeem an introduction string; board first when this machine has no key')
    .argument('[string]', 'introduction token (zint_…) or its public link')
    .option('--name <label>', 'what the consent page shows for this machine', hostname() || 'ziggs-cli')
    .option('--forget-key', 'remove the stored key for this API base and exit')
    .action(async (raw: string | undefined, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      try {
        const apiBase = resolveApiBase();
        if (opts.forgetKey) {
          const cleared = clearStoredKey(apiBase);
          if (json) {
            print({ cleared, path: credentialsPath(), apiBase }, true);
            return;
          }
          console.log(
            cleared
              ? `Removed stored key for ${apiBase} (${credentialsPath()}).`
              : `No stored key for ${apiBase}.`,
          );
          return;
        }

        if (!raw) {
          throw new Error('pass an introduction token (zint_…) or its link');
        }
        const token = extractIntroductionToken(raw);
        const existing = tryLoadCreds();

        if (existing) {
          const client = new IntroductionsClient(
            existing.operatorKey,
            existing.agentId || undefined,
          );
          const intro = await client.redeem(token);
          const outcome = intro.outcome ?? 'ok';
          const message =
            intro.counterparty?.nextStep ??
            (intro.outcome === 'joined' ? 'You are in.' : 'Redeemed.');
          const payload = { outcome, message, introduction: intro };
          if (json) {
            print({ ...payload, next: 'ziggs inbox --wait' }, true);
            return;
          }
          console.log(formatJoinHuman(payload));
          return;
        }

        const started = await boardIntroduction(apiBase, token, String(opts.name));
        if (!json) {
          console.log(
            [
              'Open this link and Allow (one click boards and redeems):',
              started.verification_uri_complete,
              `Code: ${started.user_code}`,
              'Waiting for approval…',
            ].join('\n'),
          );
        }
        const minted = await pollDeviceToken(apiBase, started);
        writeStoredKey(apiBase, {
          operatorKey: minted.access_token,
          ...(minted.refresh_token ? { refreshToken: minted.refresh_token } : {}),
          clientId: started.client_id,
        });
        const path = credentialsPath();
        // Approval already redeemed (board door). A second redeem would spend
        // another seat or fail; tell the person to listen instead.
        const payload = {
          outcome: 'joined',
          message:
            'Boarded. The click that approved this machine also redeemed the introduction.',
          storedKeyPath: path,
        };
        if (json) {
          print(
            {
              ...payload,
              token,
              apiBase,
              next: 'ziggs inbox --wait',
              keyFile: path,
            },
            true,
          );
          return;
        }
        console.log(formatJoinHuman(payload));
      } catch (err) {
        handleError(err, json);
      }
    });
}
