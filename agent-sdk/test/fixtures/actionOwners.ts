import type { WorkExecutionContext } from '@ziggs-ai/contracts';

/** Existing inbox cases describe assigned duties. Supply their explicit owner
 * projection and prepare endpoint at the fixture boundary, never in host code. */
export function withActionOwnerFixtures(fetchFixture: (...args: any[]) => Promise<Response>) {
  const contexts = new Map<string, WorkExecutionContext>();
  return async (url: any, init?: RequestInit): Promise<Response> => {
    if (String(url).endsWith('/execution/prepare')) {
      const action = JSON.parse(String(init?.body));
      const headers = new Headers(init?.headers);
      const known = contexts.get(JSON.stringify(action));
      return Response.json(known ?? { contextId: `xec_${action.kind}_${action.id}`, action,
        actorId: headers.get('X-Agent-Id') ?? headers.get('X-Ziggs-Agent-Id'), principalId: 'owner', agreementId: null,
        position: 'participant', audienceIds: ['owner'], audienceRevision: 'current' });
    }
    const response = await fetchFixture(url, init);
    if (!String(url).includes('/inbox') || String(url).includes('/inbox/') || !response.ok) return response;
    const body = await response.json();
    for (const row of body.deliveries ?? []) {
      if (!row.assigneeId || row.action !== undefined || row.kind === 'request') continue;
      row.action = row.kind === 'message'
        ? { kind: 'message', id: row.resourceId }
        : row.kind === 'task-state' ? { kind: 'task', id: row.resourceId }
        : { kind: 'agreement', id: row.agreementId ?? row.resourceId };
      const context = row.executionContext ?? { contextId: `xec_${row.kind}_${row.resourceId}`, actorId: row.assigneeId, principalId: 'owner',
        agreementId: row.agreementId ?? null, position: 'participant', audienceIds: ['owner'], audienceRevision: 'current' };
      contexts.set(JSON.stringify(row.action), { ...context, action: row.action });
    }
    return Response.json(body, { status: response.status });
  };
}
