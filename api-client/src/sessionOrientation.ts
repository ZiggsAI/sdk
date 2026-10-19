/**
 * Who this session is, who it represents, and whether it can continue
 * unattended. Built from the binding the caller already has. Does not
 * read mail and does not take the inbox lease.
 */

export type InboxAckDriver = 'agent' | 'host';

export type ContinuationKind = 'manual' | 'scheduled';

export interface RepresentedPerson {
  /** The human this agent acts for. Null when the key does not name one. */
  id: string | null;
  kind: 'user';
}

export interface SessionContinuation {
  kind: ContinuationKind;
  canScheduleWake: boolean;
  summary: string;
}

export interface InboxHandling {
  /** Who closes the inbox loop. Never both on the same identity. */
  ackDriver: InboxAckDriver;
  readAcquiresHost: true;
  peekDoesNotAcquire: true;
  peek: { tool: string; http: { method: 'GET'; path: '/inbox/peek' } };
}

export interface SessionOrientation {
  representedPerson: RepresentedPerson;
  continuation: SessionContinuation;
  inboxHandling: InboxHandling;
  identity: {
    agentId: string;
    distinctFromBackgroundWorker: true;
  };
}

export interface SessionOrientationInput {
  agentId: string;
  ownerUserId: string | null;
  /** MCP assistants ack themselves. The hosted SDK host acks; the brain does not. */
  surface: 'mcp' | 'sdk';
}

const PEEK = {
  tool: 'ziggs_inbox_peek',
  http: { method: 'GET' as const, path: '/inbox/peek' as const },
};

/**
 * Facts a cold entry needs that `session.ownerId` never labelled: the
 * represented person, whether this host can arm a wake, and who drives ack.
 */
export function sessionOrientation(
  input: SessionOrientationInput,
): SessionOrientation {
  const mcp = input.surface === 'mcp';
  return {
    representedPerson: {
      id: input.ownerUserId,
      kind: 'user',
    },
    continuation: mcp
      ? {
          kind: 'manual',
          canScheduleWake: false,
          summary:
            'This MCP session has no wake_at. Continue by calling ziggs_inbox again — a scheduler in the host is the only unattended path.',
        }
      : {
          kind: 'scheduled',
          canScheduleWake: true,
          summary:
            'The hosted runtime can arm wake_at. The brain does not ack; the host owns the inbox loop.',
        },
    inboxHandling: {
      ackDriver: mcp ? 'agent' : 'host',
      readAcquiresHost: true,
      peekDoesNotAcquire: true,
      peek: PEEK,
    },
    identity: {
      agentId: input.agentId,
      distinctFromBackgroundWorker: true,
    },
  };
}
