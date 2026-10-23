import { AgentSearchClient, type AgentProfile } from '../http/AgentSearchClient.js';
import { getMyAgreements } from '../http/AgreementClient.js';
import { activeHiresForAgent, type ActiveHire } from './activeHire.js';
import { RESOURCE_HIDDEN_MESSAGE } from './context.js';
import { type CapabilityDefinition, type CapabilityEnv, fullCreds } from './types.js';

export const agentSearchCapability: CapabilityDefinition = {
  key: 'agent_search',
  names: { sdk: 'agent_search', mcp: 'ziggs_agent_search' },
  title: 'Search for agents',
  descriptions: {
    sdk: 'Search for agents by capability, name, or description. Returns ranked results with relevance scores. A keyword/natural-language query searches the published store, your org\'s own agents and your own agents, and it matches your teammates by name: a teammate comes back under `people` as a person to message (chat_open with their userId), never as a list of their agents. Someone else\'s agent is reached through the person it answers for, inside your org and outside it: you message the person, which of their agents answers is theirs to decide, and their agents become known to you by turning up in rooms. A link works the same way: reach a linked person through the link itself (link_list gives their addressable peer id, then chat_open). Passing an EXACT agent id resolves that one agent when you can reach it. Each row carries `doors` — its engagement doors: doors.listingAgreementId is a live listing to CLAIM (agreement_claim — the default, one hop from here) and doors.acceptsProposals says whether a direct proposal would even be accepted (most published agents are claim-only). Use returned agentId in grant/issue tools — do not guess ids. When the caller already hires an agent, that row says already hired and names the agreement id and workspace.',
  },
  annotation: 'read-only',
  params: {
    query: {
      type: 'string',
      required: true,
      description:
        "Keyword/natural-language search (published store, your org's own agents, your own agents, and teammates by name) OR an exact agent id (resolves that agent when you can reach it)",
    },
    limit: { type: 'number', description: 'Max results (default server-side)' },
    minScore: { type: 'number', description: 'Minimum match score filter' },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    if (!args['query']) throw new Error('query is required');
    const creds = fullCreds(env);
    const client = new AgentSearchClient(creds.operatorKey, creds.agentId);
    const result = await client.searchAgents(args['query'] as string, {
      limit: typeof args['limit'] === 'number' ? (args['limit'] as number) : undefined,
      minScore: typeof args['minScore'] === 'number' ? (args['minScore'] as number) : undefined,
    });
    if (!result.success) {
      throw new Error(result.error ?? result.message ?? 'search failed');
    }
    const chatOpen = env.surface === 'mcp' ? 'ziggs_chat_open' : 'chat_open';
    const linkList = env.surface === 'mcp' ? 'ziggs_link_list' : 'link_list';
    const marketplace = env.surface === 'mcp' ? 'ziggs_marketplace_view' : 'marketplace_view';
    const request = env.surface === 'mcp' ? 'ziggs_agreement_request' : 'agreement_request';
    const people = result.people ?? [];
    const messageThem = people.length
      ? {
          people,
          peopleNote: `These are teammates whose name matched. Message the person with ${chatOpen} participantId=<userId>; which of their agents answers is theirs to decide.`,
        }
      : {};
    const hired = await hireNotes(result.agents ?? [], env);
    const agents = (result.agents ?? []).map((agent) => withHire(agent, hired));
    if (!agents.length) {
      // a bare {count: 0} reads as "discovery is down" to LLM
      // callers — say what was searched and how to recover instead.
      return {
        count: 0,
        agents: [],
        ...messageThem,
        searched: [
          'published store: agents by name, description and tags',
          "your org's own agents and your own agents: by name, description and tags",
          'your org: people by name (returned under people, to message as people)',
        ],
        hint:
          'Zero agents means no agent matched these terms; discovery itself is up. ' +
          // An agent given work to farm out stopped here with it undone. The
          // next rungs of the hiring ladder belong at the moment the search
          // comes back empty, not in a skill loaded every session.
          `To get work done, open listings and requests are in ${marketplace}; when nothing fits, post the work with ${request} so whoever can do it claims it. ` +
          "People are not agents: a teammate is found by their name and comes back under people, never as their agents. " +
          `To reach them, open a chat with that user id (${chatOpen} participantId). ` +
          'Matching is lexical, so try shorter or different keywords. ' +
          'If you already know the agent, pass its exact agent id as the query to resolve it directly. ' +
          'Searching for someone you are LINKED with will always miss: a link makes the person addressable, ' +
          `not their agents. Take their peer id from ${linkList} and open a chat with the person instead.`,
      };
    }
    return {
      count: agents.length,
      agents,
      ...(hired.checked ? {} : { hireCheck: 'unavailable' }),
      ...messageThem,
    };
  },
  sdkOptions: { isGenericFallback: true },
};

export const agentGetCapability: CapabilityDefinition = {
  key: 'agent_get',
  names: { sdk: 'agent_get', mcp: 'ziggs_agent_get' },
  title: 'Read an agent profile',
  descriptions: {
    sdk: 'Fetch the full profile of a specific agent by ID — name, description, tags, capabilities, reachability, reliability, and `doors` (engagement doors: doors.listingAgreementId to CLAIM — the default engagement — and doors.acceptsProposals for whether a direct proposal is even accepted). Use to confirm capabilities and terms before engaging, when you already hold the agent id. An id you cannot reach returns reachability "restricted" (id only, no profile). To find an agent by keyword instead, use agent_search.',
  },
  annotation: 'read-only',
  params: {
    agentId: { type: 'string', required: true, description: 'Exact agent id to fetch — do not guess' },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    if (!args['agentId']) throw new Error('agentId is required');
    const creds = fullCreds(env);
    const client = new AgentSearchClient(creds.operatorKey, creds.agentId);
    const result = await client.getAgentById(args['agentId'] as string);
    if (!result.success) {
      // A missing agent and one you may not see answer alike, in the words
      // every read tool uses. There is nothing to request: an agent is reached
      // through its listing or its person, not by access to its profile.
      if (result.error === 'agent not found') {
        throw Object.assign(new Error(RESOURCE_HIDDEN_MESSAGE), { code: 'RESOURCE_HIDDEN' });
      }
      throw new Error(result.error ?? 'Failed to get agent details');
    }
    const { success: _success, ...agent } = result;
    return { agent };
  },
};

export const DISCOVERY_CAPABILITIES: CapabilityDefinition[] = [
  agentSearchCapability,
  agentGetCapability,
];

function withHire(
  agent: AgentProfile,
  hired: { byAgent: Map<string, ActiveHire[]> },
): AgentProfile & { alreadyHired?: string; hires?: ActiveHire[] } {
  const hires = hired.byAgent.get(agent.agentId);
  if (!hires?.length) return agent;
  return { ...agent, alreadyHired: 'already hired', hires };
}

/** One reachable-agreement read for the whole result. A failure is said, so a row with no hire field was checked. */
async function hireNotes(
  agents: readonly AgentProfile[],
  env: CapabilityEnv,
): Promise<{ checked: boolean; byAgent: Map<string, ReturnType<typeof activeHiresForAgent>> }> {
  const byAgent = new Map<string, ReturnType<typeof activeHiresForAgent>>();
  if (agents.length === 0) return { checked: true, byAgent };
  try {
    const agreements = await getMyAgreements({}, fullCreds(env));
    for (const agent of agents) {
      const hires = activeHiresForAgent(agent.agentId, agreements);
      if (hires.length) byAgent.set(agent.agentId, hires);
    }
    return { checked: true, byAgent };
  } catch {
    return { checked: false, byAgent };
  }
}
