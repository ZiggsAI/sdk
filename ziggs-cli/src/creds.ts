import 'dotenv/config';
import { createRequire } from 'node:module';
import {
  cliHostIdentity,
  configureApiClient,
  resolveDelegateCreds,
  resolveDelegateHttpUrl,
  type Creds,
} from '@ziggs-ai/api-client';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

function delegateEnv() {
  return {
    ZIGGS_API_URL: process.env.ZIGGS_API_URL,
    HTTP_URL: process.env.HTTP_URL,
    ZIGGS_OPERATOR_KEY: process.env.ZIGGS_OPERATOR_KEY,
    ZIGGS_AGENT_ID: process.env.ZIGGS_AGENT_ID,
  };
}

// api-client never reads the environment. Point it at the URL this process
// was given before any command builds a client. ZIGGS_API_URL wins over a
// checkout's HTTP_URL.
const httpUrl = resolveDelegateHttpUrl(delegateEnv());
if (httpUrl) configureApiClient({ httpUrl });

export function loadCreds(): Creds {
  let resolved;
  try {
    resolved = resolveDelegateCreds(delegateEnv());
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
  if (!resolved.agentId) {
    console.error('Error: ZIGGS_AGENT_ID is not set');
    process.exit(1);
  }
  return {
    operatorKey: resolved.operatorKey,
    agentId: resolved.agentId,
    instanceId: cliHostIdentity(),
  };
}

export const cliVersion = version;
