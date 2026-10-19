import { defineTool, type ToolDefinition } from './defineTool.js';
import { laneFromToolContext } from './toolCreds.js';
import type { CapabilityDefinition, CapabilityEnv } from '@ziggs-ai/api-client';
import { resolveBackendUrl } from '../shared/backendUrl.js';

type Ctx = Record<string, unknown>;

/**
 * the SDK surface adapter for shared capability definitions
 * (api-client `capabilities/`). One capability (schema + handler + guidance)
 * becomes a defineTool ToolDefinition: the neutral param DSL feeds defineTool's
 * JSON-schema converter unchanged, and the handler runs with creds pulled from
 * tool context plus the SDK runner's base-URL overrides.
 */
export function toolFromCapability(cap: CapabilityDefinition): ToolDefinition {
  return defineTool(
    cap.names.sdk,
    cap.params as Record<string, unknown>,
    async (args, ctx) => {
      const operatorKey = (ctx as Ctx)?.['operatorKey'] as string | undefined;
      const agentId = (ctx as Ctx)?.['agentId'] as string | undefined;
      // The lane the wake is running in was already threaded to this exact
      // point by the shared executor (`chatId: effect.sessionId` in
      // executeToolWithSideEffects). `laneFromToolContext` is the one reader
      // for it, which makes the fence brain-agnostic by construction — the
      // Claude brain, the FSM brain and hand-written tools all claim the same
      // lane instead of each author remembering to. A capability may run
      // without an agent id (`needsAgentId: false`), which is why this builds
      // the creds itself rather than calling `credsFromToolContext`.
      const laneId = laneFromToolContext(ctx as Ctx);
      if (!operatorKey) throw new Error('operatorKey missing from tool context');
      if (cap.needsAgentId && !agentId) throw new Error('agentId missing from tool context');
      const env: CapabilityEnv = {
        creds: {
          operatorKey,
          ...(agentId ? { agentId } : {}),
          ...(laneId ? { laneId } : {}),
        },
        baseUrl: resolveBackendUrl(),
        webUrl: process.env.ZIGGS_WEB_URL,
        surface: 'sdk',
        serviceAgreementId: typeof (ctx as Ctx).serviceAgreementId === 'string' ? (ctx as Ctx).serviceAgreementId as string : undefined,
      };
      return cap.handler(args, env);
    },
    { description: cap.descriptions.sdk, ...(cap.sdkOptions ?? {}) },
  );
}

export function toolsFromCapabilities(caps: CapabilityDefinition[]): ToolDefinition[] {
  return caps.map(toolFromCapability);
}
