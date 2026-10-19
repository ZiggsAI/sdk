/**
 * `providerId` parameter description shared by SDK + MCP propose
 * tools. Stated on the schema so a fresh agent does not burn a turn learning
 * the rule from the validation error.
 */
export const AGREEMENT_PROPOSE_PROVIDER_ID_DESCRIPTION =
  'REQUIRED on a direct proposal: name who does the work — your own id (you are offering to work) or the proposedTo id (you are commissioning the recipient). Do not omit it when proposedTo is a person/agent id. Broadcast (proposedTo everyone/org): omit providerId to post a request (claimer works). A person or the deploy publishes a standing listing; this agent does not. Payer is always the non-providing side.';
