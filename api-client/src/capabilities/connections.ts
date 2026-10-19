import { ConnectionsClient } from "../http/ConnectionsClient.js";
import {
  type CapabilityDefinition,
  type CapabilityEnv,
  rethrowWithContext,
} from "./types.js";

function client(env: CapabilityEnv): ConnectionsClient {
  // laneId, not just the key and the agent. The lane is which hire this wake is
  // in, and the broker reads off it who the agent is acting for — which is what
  // tells one hirer's grant from another's: an agent that serves several hirers
  // is the holder of every grant it has been given, so the holder check alone
  // cannot separate them. Every other Creds-based client already carries it.
  const { operatorKey, agentId, laneId } = env.creds;
  if (!operatorKey) throw new Error("operatorKey missing from tool context");
  return new ConnectionsClient(operatorKey, agentId, env.baseUrl, laneId);
}

export const connectionProxyCapability: CapabilityDefinition = {
  key: "connection_proxy",
  names: { sdk: "connection_proxy", mcp: "ziggs_connection_proxy" },
  title: "Use a stored connection",
  descriptions: {
    sdk:
      "Use a named-connector stored connection (e.g. the owner's GitHub/Jira) without ever seeing the credential. " +
      "Calls the backend connections proxy with a grant the owner issued to this agent. " +
      'Not for remote MCP servers (provider "mcp") — those use mcp_tool_call / mcp_tools_list; proxy refuses them with "Unknown provider: mcp". ' +
      "Don't know connectionId/grantId yet? Use grant_list (scopeKind [\"connection\"]) or connection_list_grants first.",
  },
  annotation: "destructive",
  params: {
    connectionId: {
      type: "string",
      required: true,
      description: "Connection to act on",
    },
    grantId: {
      type: "string",
      required: true,
      description: "Grant the owner issued to this agent for the connection",
    },
    action: {
      type: "string",
      required: true,
      description: "Provider action, e.g. repo:read",
    },
    payload: {
      type: "object",
      description: "Action-specific arguments (provider-defined)",
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    if (!args["connectionId"]) throw new Error("connectionId is required");
    if (!args["grantId"]) throw new Error("grantId is required");
    if (!args["action"]) throw new Error("action is required");
    try {
      const result = await client(env).proxy({
        connectionId: args["connectionId"] as string,
        grantId: args["grantId"] as string,
        action: args["action"] as string,
        payload: args["payload"],
      });
      return { ok: true, action: args["action"], result };
    } catch (e) {
      rethrowWithContext(e, "Connection proxy failed");
    }
  },
};

export const requestConnectionCapability: CapabilityDefinition = {
  key: "connection_request",
  names: { sdk: "connection_request", mcp: "ziggs_connection_request" },
  title: "Ask someone for a connection",
  descriptions: {
    sdk:
      "Ask a person to connect a remote MCP server and grant you the listed tools. " +
      "Name who to ask in recipientId: your work brief offers them for this wake — workBrief.actingFor.customer.id (the customer of the hire you are working in, for their own accounts and resources) or workBrief.actingFor.operator.id (your operator, for tools you bring). Anyone else is refused, and the refusal lists who you can ask. " +
      "Opens a connection-consent card in the chat you pass; the answer says who got it and where they approve it — tell that person, not whoever happens to be in the room. " +
      "On approval the server is connected (browser OAuth if needed) and you are granted the tools; call them with mcp_tool_call / mcp_tools_list (not connection_proxy).",
  },
  annotation: "destructive",
  params: {
    chatId: {
      type: "string",
      required: true,
      description:
        "The chat you are working in — the consent card is opened there",
    },
    serverUrl: {
      type: "string",
      required: true,
      description: "Remote MCP server URL (https)",
    },
    tools: {
      type: "array",
      items: { type: "string" },
      required: true,
      description:
        "Tool names you want — become the grant's allowed_actions caveats",
    },
    reason: {
      type: "string",
      description: "Plain-language reason shown to the human deciding",
    },
    recipientId: {
      type: "string",
      required: true,
      description:
        "Who to ask: workBrief.actingFor.customer.id (the customer of this hire, for their own accounts) or workBrief.actingFor.operator.id (your operator, for tools you bring)",
    },
  },
  needsAgentId: true,
  handler: async (args, env) => {
    if (!args["chatId"]) throw new Error("chatId is required");
    if (!args["serverUrl"]) throw new Error("serverUrl is required");
    const tools = args["tools"];
    if (!Array.isArray(tools) || tools.length === 0) {
      throw new Error("tools must be a non-empty array of tool names");
    }
    if (typeof args["recipientId"] !== "string" || !args["recipientId"].trim())
      throw new Error("recipientId is required: who to ask, from your work brief");
    try {
      const result = await client(env).requestMcpConnection({
        chatId: args["chatId"] as string,
        serverUrl: args["serverUrl"] as string,
        tools: tools as string[],
        reason: args["reason"] as string | undefined,
        recipientId: (args["recipientId"] as string).trim(),
      });
      // Who got the card is the server's answer; say that, never "your
      // principal" — the card often goes to someone else.
      const sent =
        typeof result["message"] === "string"
          ? (result["message"] as string)
          : "A connection-consent card is open.";
      return {
        ok: true,
        ...result,
        note:
          env.surface === "mcp"
            ? `${sent} Tell that person now (pull-only MCP has no push). ` +
              "Once approved, the connection + grant appear in ziggs_connection_list for ziggs_mcp_tools_list / ziggs_mcp_tool_call."
            : `${sent} Tell that person; only they can approve it. ` +
              "Once approved, the connection + grant appear in grant_list (scopeKind [\"connection\"]) / connection_list_grants for mcp_tools_list / mcp_tool_call.",
      };
    } catch (e) {
      rethrowWithContext(e, "Connection request failed");
    }
  },
};

export const CONNECTION_CAPABILITIES: CapabilityDefinition[] = [
  connectionProxyCapability,
  requestConnectionCapability,
];
