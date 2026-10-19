import type { CapabilityAnnotation, CapabilityDefinition } from './types.js';
import { AGREEMENT_CAPABILITIES } from './agreements.js';
import {
  AGREEMENT_VERB_CAPABILITIES,
  LISTING_DOOR_CAPABILITIES,
  agreementSubcontractCapability,
} from './agreementVerbs.js';
import { ARTIFACT_CAPABILITIES } from './artifacts.js';
import { CHAT_CAPABILITIES } from './chat.js';
import { CONNECTION_CAPABILITIES } from './connections.js';
import { CONTEXT_CAPABILITIES } from './context.js';
import { DISCOVERY_CAPABILITIES } from './discovery.js';
import { GRANTS_CAPABILITIES } from './grants.js';
import { INTRODUCTION_CAPABILITIES } from './introductions.js';
import { LINK_CAPABILITIES } from './links.js';
import { MARKETPLACE_CAPABILITIES } from './marketplace.js';
import { PARTY_CAPABILITIES } from './parties.js';
import { PAYMENT_CAPABILITIES } from './payments.js';
import { TASK_CAPABILITIES } from './tasks.js';

const CAPABILITIES: CapabilityDefinition[] = [
  ...AGREEMENT_CAPABILITIES,
  ...AGREEMENT_VERB_CAPABILITIES,
  agreementSubcontractCapability,
  ...LISTING_DOOR_CAPABILITIES,
  ...ARTIFACT_CAPABILITIES,
  ...CHAT_CAPABILITIES,
  ...CONNECTION_CAPABILITIES,
  ...CONTEXT_CAPABILITIES,
  ...DISCOVERY_CAPABILITIES,
  ...GRANTS_CAPABILITIES,
  ...INTRODUCTION_CAPABILITIES,
  ...LINK_CAPABILITIES,
  ...MARKETPLACE_CAPABILITIES,
  ...PARTY_CAPABILITIES,
  ...PAYMENT_CAPABILITIES,
  ...TASK_CAPABILITIES,
];

const bySdkName = new Map<string, CapabilityAnnotation>();
for (const cap of CAPABILITIES) {
  if (!bySdkName.has(cap.names.sdk)) bySdkName.set(cap.names.sdk, cap.annotation);
}

/** Annotation of a shared capability, by its SDK tool name. */
export function annotationForSdkTool(name: string): CapabilityAnnotation | undefined {
  return bySdkName.get(name);
}
