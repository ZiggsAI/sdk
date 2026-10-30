import { SOURCES_PARAM, sourcesArg } from './sources.js';
import {
  ARTIFACT_FILE_FORMATS,
  ArtifactsClient,
  type ArtifactFileFormat,
  type ArtifactVisibility,
} from '../http/ArtifactsClient.js';
import { ContextGrantsClient } from '../http/ContextGrantsClient.js';
import {
  ContextDiscoveryClient,
  type DiscoverableItem,
} from '../http/ContextDiscoveryClient.js';
import { type CapabilityDefinition, type CapabilityEnv, type CapabilityParam, fullCreds } from './types.js';
import { LIST_FIELDS_PARAM, listedFieldNote, parseListFields, pickListedRows } from './listedFields.js';
import { nextCall, type NextCall } from './nextCall.js';
import type { ArtifactExternalRef } from '@ziggs-ai/contracts';

/**
 * teaching: name the result slot on the success path so an agent finds
 * the right move unaided — worded in each surface's task grammar (SDK
 * task_set_result carries the terminal result; MCP has ziggs_task_set_result).
 */
function reportingHint(
  env: CapabilityEnv,
  contentType: string | undefined,
  taskId: string | undefined,
): string {
  const close =
    env.surface === 'mcp'
      ? 'ziggs_task_set_result ({ taskId, state, result: { summary, status, links } })'
      : 'task_set_result';
  if (contentType === 'result') {
    return taskId
      ? `Recorded as a task-bound result artifact. Close the task by setting its terminal result with ${close}.`
      : `Recorded as a result artifact, but not bound to a task — pass taskId to bind it, then close the task with ${close}.`;
  }
  // The record and the delivery are different acts. A chat message
  // is not where the next agent collects the work, and saying that as "chat is
  // conversation only" read as a ban on telling the person who asked.
  return `Reporting finished work? Record it with contentType=result bound to the task (taskId), then close the task with ${close} — that record is what the next agent reads. Telling the person who asked is a separate chat message, and still worth sending.`;
}

/** Inline body cap + escape hatch, shared by SDK/MCP descriptions. */
const ARTIFACT_RECORD_INLINE_CAP =
  'Inline text max 50000 characters. Over that: pass the body as a file ' +
  '(filename + mime + contentBase64, handled in this one call), or record an ' +
  'index artifact plus part artifacts and list the part ids in the index. ' +
  'The server does not auto-split.';

/**
 * The file rail, as one call.
 *
 * Recording a file used to be three steps a caller had to perform in order:
 * ask for a presigned URL, PUT the bytes to object storage, then report the
 * sha256 back. That is our storage design surfaced as a caller obligation —
 * one of those two tools spent 1,421 characters explaining it — and every
 * agent paid for both schemas in every session whether or not it ever wrote a
 * file. Hand `contentBase64` here and the presign, the PUT and the completion
 * all happen inside this handler.
 *
 * `artifact_upload_url` / `artifact_complete_file` still exist for the one case
 * that genuinely needs them: bytes too large to travel inside a tool call (the
 * remote MCP transport caps a request body at 1MB). They are no longer the
 * documented path.
 */
/**
 * The file's bytes, or a refusal that says the payload arrived damaged.
 *
 * `Buffer.from(s, 'base64')` does not validate: it silently drops every
 * character it does not recognise and stops at the first bad padding, so a
 * truncated payload — the ordinary failure when a model inlines a long file —
 * decodes to FEWER bytes and everything downstream agrees with itself. The
 * sha256 is taken over what survived, the upload completes, and the caller is
 * told the file stored. Nothing surfaces until someone reads a garbled extract
 * with no way back to the call that wrote it.
 *
 * Re-encoding is the cheap question Node will not ask: if every character
 * carried data, the bytes round-trip to the same string. Whitespace is stripped
 * first (wrapping is normal in transports) and base64url is folded into
 * standard base64, so only genuine corruption is refused.
 */
function decodeFileBytes(contentBase64: string): Buffer {
  const normalized = contentBase64
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/=+$/, '');
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.byteLength < 1) {
    throw new Error(
      'contentBase64 decoded to zero bytes — pass the base64 of the file, or use text for a text artifact.',
    );
  }
  if (bytes.toString('base64').replace(/=+$/, '') !== normalized) {
    throw new Error(
      `contentBase64 is not intact base64: ${normalized.length} characters decoded to ${bytes.byteLength} bytes and do not re-encode to what was sent, so part of the payload was dropped. ` +
        'Send the whole encoding — storing it would give you a smaller, corrupt file whose checksum matches the corruption. ' +
        'Bytes over ~1MB do not fit in a tool call at all: use artifact_upload_url for those.',
    );
  }
  return bytes;
}

async function recordFileArtifact(
  args: Record<string, unknown>,
  env: CapabilityEnv,
  visibility: ArtifactVisibility,
): Promise<Record<string, unknown>> {
  const filename = (args['filename'] as string | undefined)?.trim();
  const mime = (args['mime'] as string | undefined)?.trim();
  if (!filename) throw new Error('filename is required when passing contentBase64');
  if (!mime) throw new Error('mime is required when passing contentBase64');
  const contentBase64 = args['contentBase64'] as string;
  // Decoded once, here, and handed on as bytes: `uploadUrl` takes `content`
  // directly, so passing the string instead made every file call decode the
  // same payload twice — and a stdio caller has no 1MB cap, so "the payload"
  // can be tens of megabytes.
  const bytes = decodeFileBytes(contentBase64);

  const creds = fullCreds(env);
  const client = new ArtifactsClient(creds.operatorKey, creds.agentId);
  const taskId = args['taskId'] as string | undefined;
  const byteSize = bytes.byteLength;
  const uploaded = await client.uploadUrl({
    filename,
    name: (args['name'] as string | undefined)?.trim() || undefined,
    mime,
    // The byte length of what will be PUT, not of the base64 envelope — the
    // presign signs this number and S3 rejects a mismatch.
    byteSize,
    format: args['format'] as ArtifactFileFormat | undefined,
    visibility,
    chatId: args['chatId'] as string | undefined,
    agreementId: args['agreementId'] as string | undefined,
    serviceAgreementId: (args['serviceAgreementId'] as string | undefined) ?? (!taskId && !args['agreementId'] ? env.serviceAgreementId : undefined),
    taskId,
    idempotencyKey: args['idempotencyKey'] as string | undefined,
    // ArtifactsClient does the PUT and hands back the sha256 of what it sent,
    // so the checksum is never something the caller has to compute.
    content: bytes,
  });
  if (!uploaded.checksum) {
    throw new Error(
      `Uploaded ${filename} but the storage layer returned no checksum, so the artifact is incomplete. ` +
        `Finish it with artifact_complete_file (artifactId ${uploaded.artifactId}) once you have the sha256 of the bytes.`,
    );
  }
  const artifact = await client.completeFile(uploaded.artifactId, uploaded.checksum);
  return {
    ok: true,
    artifactId: uploaded.artifactId,
    artifact,
    visibility,
    chatId: args['chatId'] as string | undefined,
    agreementId: args['agreementId'] as string | undefined,
    taskId,
    byteSize,
    note: 'File stored and completed. Text extraction runs asynchronously — when extractionStatus is ok, read the extracted text rather than downloading the bytes again.',
    reportingHint: reportingHint(env, args['contentType'] as string | undefined, taskId),
  };
}

/** Both fields or neither. Shape is taught in the param description. */
function parseExternalRef(raw: unknown): ArtifactExternalRef | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('externalRef must be { provider, url }');
  }
  const rec = raw as Record<string, unknown>;
  const provider = typeof rec.provider === 'string' ? rec.provider.trim() : '';
  const url = typeof rec.url === 'string' ? rec.url.trim() : '';
  if (!provider && !url) return undefined;
  if (!provider || !url) {
    throw new Error('externalRef needs both provider and url');
  }
  return { provider, url };
}

export const recordArtifactCapability: CapabilityDefinition = {
  key: 'artifact_record',
  names: { sdk: 'artifact_record', mcp: 'ziggs_artifact_record' },
  title: 'Record an artifact',
  descriptions: {
    sdk:
      'Write an artifact — text (text) or a file (filename + mime + contentBase64; the upload ' +
      'happens inside this call). Scope is optional: pass agreementId or chatId to record it there, ' +
      'or pass no scope at all to record it as yours alone and attach it somewhere later. ' +
      'Set visibility explicitly. For a finished deliverable, set contentType=result and pass ' +
      'taskId to bind it to the task. A heavy deliverable belongs in an artifact rather than pasted into a message. ' +
      ARTIFACT_RECORD_INLINE_CAP,
  },
  annotation: 'write',
  params: {
    text: {
      type: 'string',
      description:
        'Artifact body for a text artifact (max 50000 chars). Pass this or contentBase64, not both.',
    },
    contentBase64: {
      type: 'string',
      description:
        'Base64 file bytes for a file artifact — requires filename and mime. This call presigns, uploads and completes; you never compute a checksum. Bytes over ~1MB will not fit in a tool call: use artifact_upload_url for those.',
    },
    name: {
      type: 'string',
      description:
        'Short name shown in lists (room, agreement, artifacts page). Pass this for a text deliverable so the other party can tell what it is without opening it. A file defaults to filename when omitted.',
    },
    filename: {
      type: 'string',
      description: 'Original filename — required with contentBase64',
    },
    mime: {
      type: 'string',
      description:
        'Content-Type of the file bytes (e.g. application/pdf) — required with contentBase64',
    },
    format: {
      type: 'string',
      enum: [...ARTIFACT_FILE_FORMATS],
      description: 'Optional file format; inferred from filename when omitted',
    },
    visibility: {
      type: 'string',
      required: true,
      enum: ['chat', 'agent-private'],
      description:
        'chat = the scope’s parties can read it; agent-private = not shared with them. ' +
        'Neither is permanent: you can share any artifact later with a specific agent.',
    },
    serviceAgreementId: { type: 'string', description: 'Agreement authorizing this work, separate from the destination chat. Defaults to the SDK wake agreement when no task/agreement scope is supplied.' },
    chatId: { type: 'string', description: 'Optional chat scope' },
    agreementId: {
      type: 'string',
      description:
        'Optional agreement scope — for a hire deliverable, prefer this. Mutually exclusive with chatId: pass one, not both.',
    },
    taskId: {
      type: 'string',
      description:
        'Optional task binding. Valid on its own — a task-bound deliverable needs no chat or agreement.',
    },
    contentType: {
      type: 'string',
      description: 'Default text; use result for a finished deliverable',
    },
    idempotencyKey: {
      type: 'string',
      description:
        'Dedup key: the same key returns the original artifact instead of a new one. Derive it from the event and step, never at random. A new revision needs a new key.',
    },
    externalRef: {
      type: 'object',
      description:
        'When the deliverable lives in another system: { provider, url }. Both required. ' +
        'text is the in-Ziggs summary. Ziggs stores the link and does not fetch it. ' +
        'A grant on this artifact does not open the other system.',
    },
    sources: SOURCES_PARAM,
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const agreementId = args['agreementId'] as string | undefined;
    // Both containers is refused, not resolved. This used to drop chatId and
    // call agreement the winner — two answers to one call, and the silent one
    // was worse: the artifact landed somewhere the caller had just been told it
    // would also appear. The refusal itself lives in ArtifactsClient, the one
    // gate every writer goes through, so this surface cannot drift from the
    // others by wording its own verdict.
    const chatId = args['chatId'] as string | undefined;
    // no scope is legal. The throw that used to live here ("Pass
    // chatId or agreementId") is the exact failure this ticket removed — it cost
    // a live agent a turn mid-delivery for naming no container, when the record
    // itself never needed one.
    const visibility = args['visibility'] as ArtifactVisibility;
    if (visibility !== 'chat' && visibility !== 'agent-private') {
      throw new Error('visibility must be chat or agent-private');
    }
    // One tool, two body forms. Both at once is refused rather
    // than resolved: which one won would be invisible in the response.
    const text = args['text'] as string | undefined;
    const contentBase64 = args['contentBase64'] as string | undefined;
    if (text != null && contentBase64 != null) {
      throw new Error('Pass text or contentBase64, not both');
    }
    if (contentBase64 != null) {
      return recordFileArtifact(args, env, visibility);
    }
    if (text == null) {
      throw new Error(
        'Pass text for a text artifact, or contentBase64 (with filename and mime) for a file',
      );
    }
    const contentType = args['contentType'] as string | undefined;
    const taskId = args['taskId'] as string | undefined;
    const externalRef = parseExternalRef(args['externalRef']);
    const creds = fullCreds(env);
    const { artifactId } = await new ArtifactsClient(creds.operatorKey, creds.agentId).writeStrict({
      text,
      name: (args['name'] as string | undefined)?.trim() || undefined,
      visibility,
      chatId,
      agreementId,
      taskId,
      serviceAgreementId: (args['serviceAgreementId'] as string | undefined) ?? (!taskId && !agreementId ? env.serviceAgreementId : undefined),
      contentType,
      idempotencyKey: args['idempotencyKey'] as string | undefined,
      ...(externalRef ? { externalRef } : {}),
      ...sourcesArg(args),
    });
    return {
      ok: true,
      artifactId,
      visibility,
      chatId,
      agreementId,
      taskId,
      reportingHint: reportingHint(env, contentType, taskId),
    };
  },
};

/**
 * the artifacts you wrote, across every scope and none.
 *
 * The scope listings (`context_read` via chat / agreement / task) read attach
 * tables, so a free-standing artifact appears in none of them. This is how an
 * agent finds what it recorded without naming a container.
 */
export const listArtifactsCapability: CapabilityDefinition = {
  key: 'artifact_list',
  names: { sdk: 'artifact_list', mcp: 'ziggs_artifact_list' },
  title: 'List artifacts you wrote',
  descriptions: {
    sdk: 'List business artifacts you authored, in any scope or none — including free-standing ones no scope read can reach. Tool-operation and thought traces are excluded. Forward-delta with `after`.',
  },
  annotation: 'read-only',
  params: {
    after: {
      type: 'string',
      description: 'ISO timestamp — return only artifacts written strictly after this',
    },
    limit: { type: 'number', description: 'Page size (server default when omitted)' },
    fields: LIST_FIELDS_PARAM,
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const listed = await new ArtifactsClient(
      creds.operatorKey,
      creds.agentId,
    ).list(
      { authoredBy: 'me' },
      {
        after: args['after'] as string | undefined,
        limit: typeof args['limit'] === 'number' ? (args['limit'] as number) : undefined,
      },
    );
    const fields = parseListFields(args['fields']);
    return fields
      ? {
          ...listed,
          artifacts: pickListedRows(listed.artifacts, fields),
          ...listedFieldNote(listed.artifacts, fields),
        }
      : listed;
  },
};

/**
 * What the agent could not read, said as metadata and nothing else.
 *
 * The one thing this block must never become is a second results list. A row
 * here is a LABEL — `context_discover_grantable` re-shapes every row to
 * type/label/scopeRef/orgId on the way through, so no message, no member name
 * and no artifact body can travel in it, and none of these scopes were searched
 * at all. Keeping them in a separate field with its own wording is the whole
 * point: an agent that cannot tell "no match in what I can read" from "there is
 * a locked room over there" will confidently report the first while the answer
 * sits in the second.
 */
export interface UnsearchedContext {
  /** Locked scopes, labels only — never content, never counts of content. */
  items: (DiscoverableItem & { requestAccess: NextCall })[];
  count: number;
  note: string;
}

const UNSEARCHED_NOTE =
  'These were NOT searched. You hold no grant on them, so only their label is ' +
  'visible here — no contents, no message counts, nothing that would leak what ' +
  'is inside. Each row carries requestAccess: an access explanation, not a ' +
  'root grant. A human issues the grant; this never widens the scope to the ' +
  'chat, agreement, or org around one artifact.';

const OPEN_ID_FIELD: Record<string, string> = {
  chat: 'chatId',
  agreement: 'agreementId',
  artifact: 'artifactId',
  task: 'taskId',
};

function pendingAccessReceipt(
  result: { agreementId: string; ownerId?: string },
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...extra,
    ok: false,
    outcome: 'pending' as const,
    status: 'pending_approval',
    state: 'requested',
    recoverable: true,
    agreementId: result.agreementId,
    ownerId: result.ownerId,
  };
}

/**
 * The locked scopes near a search that found nothing.
 *
 * Fetched only when it changes what a caller should conclude, which is why it
 * is not on every response: an agent holding a page of matches does not need
 * the list of doors it has not opened, and an extra round trip on every find
 * would buy nothing. A search that came back empty is exactly where the wrong
 * conclusion gets drawn, so that is where this arrives unasked.
 *
 * Discovery failing is not find failing. It is bounded to orgs the agent holds
 * an active work agreement in and can legitimately return nothing, or refuse;
 * either way the matches already computed are the answer, and the miss is
 * reported as a limitation rather than thrown over the top of them.
 */
async function unsearchedContext(
  env: CapabilityEnv,
): Promise<UnsearchedContext | { note: string }> {
  const creds = fullCreds(env);
  let items: DiscoverableItem[];
  try {
    items = await new ContextDiscoveryClient(
      creds.operatorKey,
      creds.agentId,
    ).discoverGrantable();
  } catch (err) {
    return {
      note:
        'Could not check for context you cannot read yet: ' +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'Treat this answer as covering only what was searched.',
    };
  }
  return {
    items: items.map((item) => {
      const idField = OPEN_ID_FIELD[item.scopeRef.kind];
      return {
        ...item,
        requestAccess: nextCall(
          env,
          'access_explain',
          idField ? { [idField]: item.scopeRef.id } : undefined,
          idField
            ? `explain access to locked ${item.type} "${item.label}" — a human issues a root grant; this call does not request or widen`
            : `locked ${item.type} "${item.label}" cannot be requested from this surface — a human issues a root grant; this never widens the scope`,
          {
            hold: 'human_approval',
            ...(idField ? {} : { outcome: 'unavailable' as const }),
          },
        ),
      };
    }),
    count: items.length,
    note: UNSEARCHED_NOTE,
  };
}

/**
 * search the work you hold, and say what you searched.
 *
 * `artifact_list` answers "what did I write" and the scope reads answer "what
 * is in this container". Neither answers "where is the thing about X", which is
 * the question an agent actually has when it has been handed work that refers
 * to something it did not produce. The server bounds this by the agent's own
 * reach — authorship, readable containers, artifact grants it holds — under the
 * active lane and shared-room containment, so there is no `reach` arm to ask
 * for and the narrowing filters are refused rather than ignored.
 *
 * The response is deliberately two things that never merge: `artifacts`, which
 * is readable content that matched, and `notSearched`, which is labels of
 * scopes that were never opened. `coverage` sits between them naming what ran.
 */
export const findArtifactsCapability: CapabilityDefinition = {
  key: 'artifact_find',
  names: { sdk: 'artifact_find', mcp: 'ziggs_artifact_find' },
  title: 'Find artifacts you can read',
  descriptions: {
    sdk:
      'Search business artifacts you can already reach (excluding tool-operation and thought traces) — what you authored, what your readable chats/agreements/tasks hold, and what artifact grants you hold — by words in the name, filename or body. Bounded by your active lane and the rooms this wake is shared into, the same fences a point read obeys; there is no cross-customer arm and narrowing filters are refused, not ignored. Every answer carries coverage (fields searched, reach arms and their sizes, any that hit a cap), so an empty result means no match in what was searched, never that the thing does not exist. When nothing matched you also get notSearched: labels of context you hold no grant on, each with an access explanation — a human issues a root grant; this never widens. Metadata only, never contents.',
  },
  annotation: 'read-only',
  params: {
    q: {
      type: 'string',
      required: true,
      description:
        'Words to match; every term must appear. This is a lexical match on name, filename and extracted text — not a semantic search.',
    },
    limit: { type: 'number', description: 'Page size (server default when omitted)' },
    before: {
      type: 'string',
      description:
        'Older-rows cursor: pass the previous page’s coverage.nextCursor back verbatim (opaque).',
    },
    includeUnreadable: {
      type: 'boolean',
      description:
        'Also list context you hold no grant on (labels only, never contents). When omitted, that list is attached only if nothing matched. Pass true to ask for it alongside matches. Pass false to leave it off.',
    },
    fields: LIST_FIELDS_PARAM,
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const found = await new ArtifactsClient(
      creds.operatorKey,
      creds.agentId,
    ).find(args['q'] as string, {
      limit: typeof args['limit'] === 'number' ? (args['limit'] as number) : undefined,
      before: args['before'] as string | undefined,
    });
    const fields = parseListFields(args['fields']);
    const shaped = fields
      ? {
          ...found,
          artifacts: pickListedRows(found.artifacts, fields),
          ...listedFieldNote(found.artifacts, fields),
        }
      : found;
    if (args['includeUnreadable'] === false) return shaped;
    const asked = args['includeUnreadable'] === true;
    if (!asked && found.artifacts.length > 0) return shaped;
    return { ...shaped, notSearched: await unsearchedContext(env) };
  },
};

/**
 * hand one artifact you authored to one other agent.
 *
 * Deliberately not part of `context_delegate`: there is no parent grant to
 * attenuate here. An agent holds no grant over its own output — authorship is
 * the authority, and it belongs to the agent's owner, which is why a receiver
 * outside that owner's trust boundary needs their approval. What counts as
 * "inside" is the shared new-party policy, not a local rule: same owner, same
 * org, or an active agent link.
 */
export const shareArtifactCapability: CapabilityDefinition = {
  key: 'artifact_share',
  names: { sdk: 'artifact_share', mcp: 'ziggs_artifact_share' },
  title: 'Share an artifact',
  descriptions: {
    sdk: 'Share an artifact you authored with another agent — just that artifact, no chat or agreement. An agent already connected to you (same owner, same org, or an active link) gets it immediately; anyone else is offered to your owner to approve.',
  },
  annotation: 'destructive',
  params: {
    artifactId: {
      type: 'string',
      required: true,
      description: 'The artifact to share — you must be its author',
    },
    holderId: { type: 'string', required: true, description: 'Agent id that receives it' },
    expiresAt: {
      type: 'string',
      description: 'ISO-8601 expiry; omit for the default grant lifetime',
    },
    chatId: {
      type: 'string',
      description:
        'Chat to surface the approval request in, when the receiver’s owner has to approve',
    },
    idempotencyKey: {
      type: 'string',
      description:
        'Replay the same share. Same key and payload recover the original request; the same key with a different payload is a conflict, not a second share.',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const creds = fullCreds(env);
    const artifactId = args['artifactId'] as string;
    if (!artifactId) throw new Error('artifactId is required');
    const holderId = args['holderId'] as string;
    if (!holderId) throw new Error('holderId is required');
    const result = await new ContextGrantsClient(
      creds.operatorKey,
      creds.agentId,
      env.baseUrl,
    ).shareArtifact(
      artifactId,
      {
        holderId,
        expiresAt: args['expiresAt'] as string | undefined,
        chatId: args['chatId'] as string | undefined,
      },
      {
        idempotencyKey:
          typeof args['idempotencyKey'] === 'string'
            ? (args['idempotencyKey'] as string)
            : undefined,
      },
    );
    if (result.status === 'pending_approval') {
      return pendingAccessReceipt(result, {
        ...result,
        note: `Requested, not granted — ${result.ownerId ?? 'the owner'} must approve agreement ${result.agreementId}. Recover that id; do not open a second card.`,
      });
    }
    return {
      ok: true,
      outcome: 'ok' as const,
      ...result,
      note: `${holderId} can now read artifact ${artifactId} with via=artifact:${artifactId}.`,
    };
  },
};

/**
 * attach an artifact you already have to a chat, a task, or an agreement.
 *
 * The other half of "record now, decide where later". Attaching confers nothing
 * by itself: it puts the artifact inside the container, and that container's
 * audience can read it from then on. Use this to publish to a room, bind a
 * deliverable to a task, or restore agreement scope after a free-standing
 * record; use artifact_share to hand it to ONE agent instead.
 */
export const attachArtifactCapability: CapabilityDefinition = {
  key: 'artifact_attach',
  names: { sdk: 'artifact_attach', mcp: 'ziggs_artifact_attach' },
  title: 'Attach to a chat, task, or agreement',
  descriptions: {
    sdk: 'Attach an artifact you can read to a chat, a task, or an agreement. Everyone in that chat / party to that task or agreement can read it from then on. Use artifact_share to give it to one specific agent instead.',
  },
  annotation: 'destructive',
  params: {
    artifactId: { type: 'string', required: true, description: 'Artifact to attach' },
    chatId: { type: 'string', description: 'Chat to attach it to' },
    taskId: { type: 'string', description: 'Task to attach it to' },
    agreementId: {
      type: 'string',
      description: 'Agreement to attach it to (POST /agreements/:id/artifacts)',
    },
    role: {
      type: 'string',
      enum: ['input', 'output'],
      description:
        'Task attach only: output (a deliverable, default) or input (something the task consumes). ' +
        'A link’s role is set once — re-attaching with a different role is refused, not changed.',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const artifactId = args['artifactId'] as string;
    if (!artifactId) throw new Error('artifactId is required');
    const chatId = args['chatId'] as string | undefined;
    const taskId = args['taskId'] as string | undefined;
    const agreementId = args['agreementId'] as string | undefined;
    const named = [chatId, taskId, agreementId].filter(Boolean).length;
    if (named !== 1) {
      throw new Error('Pass exactly one of chatId, taskId, or agreementId');
    }
    const role = (args['role'] as 'input' | 'output' | undefined) ?? 'output';
    if (role !== 'input' && role !== 'output') {
      throw new Error('role must be input or output');
    }
    const creds = fullCreds(env);
    const client = new ArtifactsClient(creds.operatorKey, creds.agentId);
    if (chatId) {
      await client.attachToChat(artifactId, chatId);
      return {
        ok: true,
        artifactId,
        chatId,
        note: `Everyone in chat ${chatId} can now read artifact ${artifactId}.`,
      };
    }
    if (agreementId) {
      await client.attachToAgreement(artifactId, agreementId);
      return {
        ok: true,
        artifactId,
        agreementId,
        note: `Artifact ${artifactId} is attached to agreement ${agreementId}; the agreement's parties can read it.`,
      };
    }
    await client.attachToTask(artifactId, taskId!, role);
    return {
      ok: true,
      artifactId,
      taskId,
      role,
      note: `Artifact ${artifactId} is attached to task ${taskId} as ${role}; the task's parties can read it.`,
    };
  },
};

/**
 * The escape hatch for bytes too big to travel inside a tool call
 * (the remote MCP transport caps a request body at 1MB). The ordinary way to
 * record a file is `artifact_record` with contentBase64, which runs this presign
 * → PUT → complete sequence internally.
 */
export const uploadArtifactUrlCapability: CapabilityDefinition = {
  key: 'artifact_upload_url',
  names: { sdk: 'artifact_upload_url', mcp: 'ziggs_artifact_upload_url' },
  title: 'Start a large file upload',
  descriptions: {
    sdk:
      'Large-file escape hatch. Ordinary files go through artifact_record (filename + mime + ' +
      'contentBase64), which does all of this in one call — use this only when the bytes are too ' +
      'large to travel inside a tool call. Returns a short-lived uploadUrl: PUT the exact byteSize ' +
      'bytes to it (Content-Type = mime), then call artifact_complete_file with the sha256 hex of ' +
      'those bytes.',
  },
  annotation: 'write',
  params: {
    filename: { type: 'string', required: true, description: 'Original filename' },
    mime: {
      type: 'string',
      required: true,
      description: 'Content-Type for the S3 PUT (e.g. text/plain; charset=utf-8)',
    },
    byteSize: {
      type: 'number',
      required: true,
      description: 'Exact byte length of the object that will be PUT (UTF-8 length for text)',
    },
    format: {
      type: 'string',
      enum: [...ARTIFACT_FILE_FORMATS],
      description: 'Optional; inferred from filename when omitted',
    },
    visibility: {
      type: 'string',
      enum: ['chat', 'agent-private'],
      description: 'Defaults server-side when omitted',
    },
    chatId: { type: 'string', description: 'Optional chat scope' },
    agreementId: {
      type: 'string',
      description: 'Optional agreement scope; mutually exclusive with chatId',
    },
    serviceAgreementId: { type: 'string', description: 'Agreement authorizing this work, separate from the destination chat.' },
    taskId: { type: 'string', description: 'Optional task binding' },
    idempotencyKey: {
      type: 'string',
      description: 'Optional dedup key for the upload-url create',
    },
    contentBase64: {
      type: 'string',
      description:
        'Optional base64 file bytes. When set, this tool PUTs to uploadUrl and returns checksum for ziggs_artifact_complete_file.',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const filename = args['filename'] as string;
    const mime = args['mime'] as string;
    const byteSize = args['byteSize'] as number;
    if (!filename?.trim()) throw new Error('filename is required');
    if (!mime?.trim()) throw new Error('mime is required');
    if (!Number.isFinite(byteSize) || byteSize < 1) {
      throw new Error('byteSize must be a positive number');
    }
    const visibility = args['visibility'] as ArtifactVisibility | undefined;
    if (
      visibility != null &&
      visibility !== 'chat' &&
      visibility !== 'agent-private'
    ) {
      throw new Error('visibility must be chat or agent-private');
    }
    const creds = fullCreds(env);
    const result = await new ArtifactsClient(
      creds.operatorKey,
      creds.agentId,
    ).uploadUrl({
      filename,
      mime,
      byteSize: Math.trunc(byteSize),
      format: args['format'] as ArtifactFileFormat | undefined,
      visibility,
      chatId: args['chatId'] as string | undefined,
      agreementId: args['agreementId'] as string | undefined,
      taskId: args['taskId'] as string | undefined,
      serviceAgreementId: (args['serviceAgreementId'] as string | undefined) ?? (!args['taskId'] && !args['agreementId'] ? env.serviceAgreementId : undefined),
      idempotencyKey: args['idempotencyKey'] as string | undefined,
      contentBase64: args['contentBase64'] as string | undefined,
    });
    return {
      ok: true,
      ...result,
      next: result.checksum
        ? 'Call artifact_complete_file / ziggs_artifact_complete_file with this artifactId and checksum.'
        : 'PUT the exact byteSize bytes to uploadUrl (Content-Type=mime), then call artifact_complete_file / ziggs_artifact_complete_file with sha256 hex of those bytes.',
    };
  },
};

export const completeArtifactFileCapability: CapabilityDefinition = {
  key: 'artifact_complete_file',
  names: { sdk: 'artifact_complete_file', mcp: 'ziggs_artifact_complete_file' },
  title: 'Finish a large file upload',
  descriptions: {
    sdk:
      'Second half of the large-file escape hatch — only needed after artifact_upload_url. ' +
      'Pass artifactId + sha256 hex of the bytes you PUT. Sets extractionStatus=pending and ' +
      'enqueues extract. Poll artifact_list or context until extractionStatus is ok/failed; ' +
      'download still works while pending.',
  },
  annotation: 'write',
  params: {
    artifactId: { type: 'string', required: true, description: 'From upload-url' },
    checksum: {
      type: 'string',
      required: true,
      description: 'sha256 hex of the bytes that were PUT',
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const artifactId = args['artifactId'] as string;
    const checksum = args['checksum'] as string;
    if (!artifactId) throw new Error('artifactId is required');
    if (!checksum) throw new Error('checksum is required');
    const creds = fullCreds(env);
    const artifact = await new ArtifactsClient(
      creds.operatorKey,
      creds.agentId,
    ).completeFile(artifactId, checksum);
    return {
      ok: true,
      artifact,
      note:
        'Extract runs asynchronously. When extractionStatus is ok, read the derived text; use artifact_download for original bytes.',
    };
  },
};

export const downloadArtifactCapability: CapabilityDefinition = {
  key: 'artifact_download',
  names: { sdk: 'artifact_download', mcp: 'ziggs_artifact_download' },
  title: 'Download a file artifact',
  descriptions: {
    sdk:
      'Get a short-lived (60s) presigned download URL for a file artifact you can read. ' +
      'Returns downloadUrl, expiresAt, filename — fetch the URL yourself; do not expect ' +
      'inline file bytes in this response.',
  },
  annotation: 'read-only',
  params: {
    artifactId: { type: 'string', required: true, description: 'File artifact id' },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const artifactId = args['artifactId'] as string;
    if (!artifactId) throw new Error('artifactId is required');
    const creds = fullCreds(env);
    const out = await new ArtifactsClient(
      creds.operatorKey,
      creds.agentId,
    ).download(artifactId);
    return { ok: true, ...out };
  },
};

export const reextractArtifactCapability: CapabilityDefinition = {
  key: 'artifact_reextract',
  names: { sdk: 'artifact_reextract', mcp: 'ziggs_artifact_reextract' },
  title: 'Re-extract text from a file',
  descriptions: {
    sdk:
      'Re-queue text extraction for a file artifact you authored when status is ok or failed ' +
      '(pending → conflict). On success a new extracted-text row supersedes the previous one.',
  },
  annotation: 'destructive',
  params: {
    artifactId: { type: 'string', required: true, description: 'File artifact id' },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    const artifactId = args['artifactId'] as string;
    if (!artifactId) throw new Error('artifactId is required');
    const creds = fullCreds(env);
    const artifact = await new ArtifactsClient(
      creds.operatorKey,
      creds.agentId,
    ).reExtract(artifactId);
    return { ok: true, artifact };
  },
};

const CONTRIBUTION_PARAMS: Record<string, CapabilityParam> = {
  artifactId: { type: 'string', required: true, description: 'The output' },
  agreementId: { type: 'string', required: true, description: 'Where it goes' },
};

function contributionTarget(args: Record<string, unknown>): { artifactId: string; agreementId: string } {
  if (typeof args.artifactId !== 'string' || !args.artifactId.trim() || typeof args.agreementId !== 'string' || !args.agreementId.trim()) throw new Error('artifactId and agreementId are required');
  return { artifactId: args.artifactId, agreementId: args.agreementId };
}

/**
 * The read half of a contribution, its own tool: a directory listing may not
 * put a safe read and an unsafe write under one annotation.
 */
export const reviewArtifactContributionCapability: CapabilityDefinition = {
  key: 'artifact_contribution_review',
  names: { sdk: 'artifact_contribution_review', mcp: 'ziggs_artifact_contribution_review' },
  title: 'Review a contribution',
  descriptions: { sdk: 'Review the approvals one immutable artifact needs before artifact_contribute delivers it to another agreement. Keep the producing execution selected. Returns source releases you can identify and a privateSourceCount for hidden upstream inputs; if that count is nonzero, the original source authority must arrange any further release. Request them with access_request using scopeId=output artifact, contributionTo=destination and releaseSource from the review. Also obtain ordinary output-owner contribution consent.' },
  annotation: 'read-only',
  needsAgentId: true,
  params: CONTRIBUTION_PARAMS,
  handler: async (args, env) => {
    const { artifactId, agreementId } = contributionTarget(args);
    const creds = fullCreds(env);
    return new ArtifactsClient(creds.operatorKey, creds.agentId).reviewContribution(artifactId, agreementId);
  },
};

export const contributeArtifactCapability: CapabilityDefinition = {
  key: 'artifact_contribute',
  names: { sdk: 'artifact_contribute', mcp: 'ziggs_artifact_contribute' },
  title: 'Contribute an output',
  descriptions: { sdk: 'Deliver one immutable artifact to another agreement once artifact_contribution_review shows it ready. Keep the producing execution selected. Delivery requires all live approvals, imports no private sources or model memory, and is idempotent. Never retry without execution context.' },
  annotation: 'destructive',
  needsAgentId: true,
  params: CONTRIBUTION_PARAMS,
  handler: async (args, env) => {
    const { artifactId, agreementId } = contributionTarget(args);
    const creds = fullCreds(env);
    return new ArtifactsClient(creds.operatorKey, creds.agentId).contribute(artifactId, agreementId);
  },
};

export const ARTIFACT_CAPABILITIES: CapabilityDefinition[] = [
  recordArtifactCapability,
  listArtifactsCapability,
  findArtifactsCapability,
  shareArtifactCapability,
  attachArtifactCapability,
  reviewArtifactContributionCapability,
  contributeArtifactCapability,
  uploadArtifactUrlCapability,
  completeArtifactFileCapability,
  downloadArtifactCapability,
  reextractArtifactCapability,
];
