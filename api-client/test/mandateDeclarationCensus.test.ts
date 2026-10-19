import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AGREEMENT_VERB_CAPABILITIES,
  LISTING_DOOR_CAPABILITIES,
  agreementSubcontractCapability,
} from '../src/capabilities/agreementVerbs.js';
import { AGREEMENT_CAPABILITIES } from '../src/capabilities/agreements.js';
import { LINK_CAPABILITIES } from '../src/capabilities/links.js';
import type { CapabilityDefinition } from '../src/capabilities/types.js';

/**
 * Every tool that can form an agreement either declares the job it is acting
 * under, or says why it does not.
 *
 * ZIG-1510. The claim surface drifted because one law was threaded by hand into
 * several doors and nothing checked that they agreed: `mandateAgreementId` was
 * honoured on two claim branches out of five and silently dropped by the other
 * three, and it shipped. The HTTP half of that is fixed by construction now —
 * one claim route, one dispatch object — but the TOOL half is still one
 * hand-written param per verb, and nothing forces a NEW verb to carry it.
 *
 * The absence is the dangerous part, and it is the same unreadable absence that
 * made the claim drift invisible. A formation that belongs to no job has to
 * say so in EXCLUDED, with a reason. Written only as a code comment, that is
 * indistinguishable from an oversight — which is exactly what someone had to
 * work out from scratch for the link branch.
 *
 * So the exclusions are data here, with their reasons, and the test fails if a
 * formation verb appears that this table has not classified.
 */

const CAPABILITIES_DIR = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'src',
  'capabilities',
);
const REPO_ROOT = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
);

/**
 * The client calls that actually form an agreement. A capability that forms one
 * has to go through one of these, so a file importing none of them cannot hold
 * a formation verb.
 */
const FORMATION_CALLS = [
  'proposeDirectTo',
  'proposeBroadcast',
  'publishOffer',
  'claimOpenAgreement',
  'createLink',
  'delegateAgreement',
] as const;

/** Why a formation verb carries no mandate declaration. Reasons, not names. */
const EXCLUDED: Record<string, string> = {
  // `link_create_invite` used to be listed here. It was deleted (ZIG-1478):
  // minting a share link is the same act as naming someone, so it is one verb
  // now with an optional target. The stale entry was caught by the second test
  // below rather than by review, which is the point of keeping this as data.
  link_propose:
    'Law 8 of the consent model: there are no job-scoped links. A link is reach between two people and an estate-level act, so it needs the principal or a covering grant, never a mandate. The claim path refuses a mandate on a link by name.',
};

/**
 * Verbs that live in a forming file but form nothing themselves, and what they
 * do instead.
 *
 * The census is per FILE — a verb that forms has to import one of the calls
 * above, so the file is what puts it in scope — which means a read verb sitting
 * beside a forming one gets asked the same question. Answering it here is the
 * point rather than the cost: "this one reads" is a claim worth being wrong
 * about out loud, and it is one line to add when a new read arrives.
 */
const FORMS_NOTHING: Record<string, string> = {
  link_list: 'Lists the links you already have. Reads, forms nothing.',
};

/**
 * Formation verbs that declare the job under a different name, and why that is
 * the same declaration rather than a second one.
 */
const DECLARES_AS: Record<string, { param: string; because: string }> = {
  agreement_handoff: {
    param: 'parentAgreementId',
    because:
      'The hire being handed off IS the job this is formed inside, and it is required rather than optional. A separate mandate field would be a second answer to one question, which is the shape that drifts.',
  },
  agreement_subcontract: {
    param: 'parentAgreementId',
    because:
      'The parent being sliced IS the job this is formed inside, and it is required. A separate mandate field would be a second name for the same parent.',
  },
};

const MANDATE_PARAM = 'mandateAgreementId';

/** `key: '<name>'` per capability file, so the census is per file, not per import. */
function capabilityKeysByFile(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of readdirSync(CAPABILITIES_DIR)) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const src = readFileSync(join(CAPABILITIES_DIR, file), 'utf8');
    const keys = [...src.matchAll(/^\s*key: '([a-z0-9_]+)',/gm)].map(
      (m) => m[1]!,
    );
    if (keys.length > 0) out.set(file, keys);
  }
  return out;
}

function filesThatCanForm(): string[] {
  // `git grep --untracked` so a capability file added in the commit under
  // review is in scope. Without the flag the census is blind to exactly the
  // change it exists to catch.
  const hits = execFileSync(
    'git',
    [
      'grep',
      '--untracked',
      // `-w`, not `\b` in the pattern: git's own `-E` engine does not
      // implement word boundaries, and a pattern it cannot parse exits 1 —
      // indistinguishable from "nothing forms an agreement". The assertion
      // below that the result is non-empty is the guard against that returning.
      '-w',
      '-l',
      '-E',
      `(${FORMATION_CALLS.join('|')})`,
      '--',
      'api-client/src/capabilities',
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .map((path) => path.split('/').pop()!);
  return [...new Set(hits)];
}

const ALL: CapabilityDefinition[] = [
  ...AGREEMENT_VERB_CAPABILITIES,
  ...LISTING_DOOR_CAPABILITIES,
  agreementSubcontractCapability,
  ...AGREEMENT_CAPABILITIES,
  ...LINK_CAPABILITIES,
];

test('every formation verb is classified: it declares the job, or says why not', () => {
  const byFile = capabilityKeysByFile();
  const formingFiles = filesThatCanForm();
  assert.ok(
    formingFiles.length > 0,
    'found no capability file that forms an agreement — the grep is broken, not the code',
  );

  const unclassified: string[] = [];
  for (const file of formingFiles) {
    for (const key of byFile.get(file) ?? []) {
      const capability = ALL.find((c) => c.key === key);
      // A capability this suite does not import cannot be judged. Every
      // forming file's exports are imported above, so a miss here means a new
      // capability list was added without being wired in.
      assert.ok(
        capability,
        `${key} is defined in ${file}, which forms agreements, but is not in any capability list this census imports`,
      );
      const declares = MANDATE_PARAM in (capability!.params ?? {});
      if (declares) continue;
      if (DECLARES_AS[key]) {
        const { param } = DECLARES_AS[key]!;
        assert.ok(
          param in (capability!.params ?? {}),
          `${key} is recorded as declaring the job as \`${param}\`, but has no such param`,
        );
        continue;
      }
      if (EXCLUDED[key]) continue;
      if (FORMS_NOTHING[key]) continue;
      unclassified.push(key);
    }
  }

  assert.deepEqual(
    unclassified,
    [],
    `These verbs can form an agreement and neither declare \`${MANDATE_PARAM}\` nor appear in the exclusion table. Add the param, or add a reason to EXCLUDED saying why this formation belongs to no job.`,
  );
});

test('the exclusions name verbs that exist, and that really omit the param', () => {
  // An exclusion for a deleted verb is worse than none: it reads as a live
  // decision and quietly stops covering anything.
  for (const [key, reason] of Object.entries(EXCLUDED)) {
    const capability = ALL.find((c) => c.key === key);
    assert.ok(capability, `EXCLUDED names ${key}, which is not a capability`);
    assert.ok(
      !(MANDATE_PARAM in (capability!.params ?? {})),
      `${key} is in EXCLUDED but declares ${MANDATE_PARAM} — the exclusion is stale`,
    );
    assert.ok(
      reason.length > 40,
      `${key}'s exclusion has to say WHY, not just that it is excluded`,
    );
  }
  for (const key of Object.keys(DECLARES_AS)) {
    assert.ok(
      ALL.some((c) => c.key === key),
      `DECLARES_AS names ${key}, which is not a capability`,
    );
  }
  for (const key of Object.keys(FORMS_NOTHING)) {
    assert.ok(
      ALL.some((c) => c.key === key),
      `FORMS_NOTHING names ${key}, which is not a capability`,
    );
  }
});

test('the five ordinary formation verbs carry the declaration', () => {
  // Named rather than derived, so deleting the param from one of them is a
  // failure here even if the table above were also edited to excuse it.
  for (const key of [
    'agreement_buy',
    'agreement_bid',
    'agreement_broker',
    'agreement_request',
    'agreement_claim',
  ]) {
    const capability = ALL.find((c) => c.key === key);
    assert.ok(capability, `${key} is missing from the capability list`);
    assert.ok(
      MANDATE_PARAM in (capability!.params ?? {}),
      `${key} no longer declares ${MANDATE_PARAM}: an agent doing assigned work would wait on its human for this`,
    );
  }
});
