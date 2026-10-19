/**
 * Connection broker demo: agent presents a ConnectionGrant and calls a
 * third-party provider action via the backend broker (never sees the token).
 *
 * Usage:
 *   BACKEND_URL=http://localhost:3000 \
 *   USER_OPERATOR_KEY=<jwt with connections:write> \
 *   AGENT_OPERATOR_KEY=<jwt with connections:use + agents:impersonate> \
 *   AGENT_ID=agent_... \
 *   CONNECTION_ID=con_... \
 *   node examples/ziggsconnect/connectionAgentDemo.js
 *
 * Prerequisites:
 *   1. User connected Jira via OAuth (POST /connections/jira/oauth/start).
 *   2. User issued a ConnectionGrant to AGENT_ID on CONNECTION_ID.
 *   3. Agent operator key has connections:use + agents:impersonate scopes.
 */

import { ConnectionsClient } from '@ziggs-ai/api-client';

const BACKEND_URL =
  process.env.BACKEND_URL || process.env.ZIGGS_BACKEND_URL || 'http://localhost:3000';
const USER_OPERATOR_KEY = process.env.USER_OPERATOR_KEY;
const AGENT_OPERATOR_KEY = process.env.AGENT_OPERATOR_KEY || process.env.USER_OPERATOR_KEY;
const AGENT_ID = process.env.AGENT_ID;
const CONNECTION_ID = process.env.CONNECTION_ID;
const PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'TEST';

if (!USER_OPERATOR_KEY || !AGENT_ID || !CONNECTION_ID) {
  console.error('Set USER_OPERATOR_KEY, AGENT_ID, CONNECTION_ID env vars.');
  process.exit(1);
}

async function issueGrant(connectionId, holderId) {
  const user = new ConnectionsClient(USER_OPERATOR_KEY, undefined, BACKEND_URL);
  const res = await user.issueGrant({
    connectionId,
    holderId,
    caveats: [
      { type: 'allowed_actions', value: ['issue:create'] },
      { type: 'allowed_resources', value: [`jira:project:${PROJECT_KEY}`] },
    ],
  });
  return res.grant;
}

async function main() {
  console.log('[1] Issue ConnectionGrant to agent (user key)...');
  const grant = await issueGrant(CONNECTION_ID, AGENT_ID);
  console.log('    grantId:', grant.grantId);

  const agent = new ConnectionsClient(AGENT_OPERATOR_KEY, AGENT_ID, BACKEND_URL);

  console.log('[2] Agent lists grants held on this connection...');
  const grants = await agent.listGrants({ connectionId: CONNECTION_ID });
  console.log('    grants:', grants.map((g) => g.grantId));

  console.log('[3] Agent creates Jira issue via connection_proxy broker...');
  const result = await agent.proxy({
    connectionId: CONNECTION_ID,
    grantId: grant.grantId,
    action: 'issue:create',
    payload: {
      projectKey: PROJECT_KEY,
      summary: 'ZiggsConnect demo issue',
      description: 'Created via ZiggsConnectClient proxy',
    },
  });
  console.log('    result:', result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
