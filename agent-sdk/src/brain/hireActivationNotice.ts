/**
 * Whether a hire-activation notice earns a model call is the host's
 * decision. The rule reads the agreement row (`formedBy`), never an
 * agent kind, name, or id shape.
 *
 * A hire an agent formed is a recorded no-op unless the hired agent's
 * manifest opts in. A hire a person formed (store claim) still wakes
 * so the provider can open the room and greet.
 */

import { SERVER_EVENTS } from '@ziggs-ai/contracts';

export type AgreementFormedBy = 'agent' | 'principal';

const ACTIVATION_LIFECYCLE_OPS = new Set([
  'proposal_approved',
  'proposal_approved_execute',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function formedByFromWake(event: unknown): AgreementFormedBy | undefined {
  const ev = asRecord(event);
  if (!ev) return undefined;
  const direct = ev.formedBy;
  if (direct === 'agent' || direct === 'principal') return direct;
  const agreement = asRecord(ev.agreement);
  const fromAgreement = agreement?.formedBy;
  if (fromAgreement === 'agent' || fromAgreement === 'principal') return fromAgreement;
  const resource = asRecord(ev.resource);
  const fromResource = resource?.formedBy;
  if (fromResource === 'agent' || fromResource === 'principal') return fromResource;
  return undefined;
}

export function agreementIdFromWake(event: unknown): string | undefined {
  const ev = asRecord(event);
  if (!ev) return undefined;
  if (typeof ev.agreementId === 'string' && ev.agreementId) return ev.agreementId;
  const agreement = asRecord(ev.agreement);
  if (typeof agreement?.agreementId === 'string' && agreement.agreementId) {
    return agreement.agreementId;
  }
  const resource = asRecord(ev.resource);
  if (typeof resource?.agreementId === 'string' && resource.agreementId) {
    return resource.agreementId;
  }
  if (
    resource?.kind === 'agreement' &&
    typeof resource.resourceId === 'string' &&
    resource.resourceId
  ) {
    return resource.resourceId;
  }
  return undefined;
}

/** Chat activation ping, store-claim doorbell, or approval-echo fan-out. */
export function isHireActivationNotice(event: unknown): boolean {
  const ev = asRecord(event);
  if (!ev) return false;
  const type = ev.type;
  const operation = typeof ev.operation === 'string' ? ev.operation : undefined;
  if (type === 'agreement_lifecycle' && operation && ACTIVATION_LIFECYCLE_OPS.has(operation)) {
    return true;
  }
  if (type !== SERVER_EVENTS.resourceChanged) return false;
  const resource = asRecord(ev.resource) ?? ev;
  const reason = typeof resource.reason === 'string' ? resource.reason : undefined;
  if (reason === 'proposal_approved') return true;
  return typeof reason === 'string' && reason.startsWith('approval:');
}

export function shouldSkipAgentFormedHireActivation(input: {
  event: unknown;
  formedBy?: AgreementFormedBy;
  actsOnHireActivation?: boolean;
}): boolean {
  if (input.actsOnHireActivation) return false;
  if (input.formedBy !== 'agent') return false;
  return isHireActivationNotice(input.event);
}
