export class ContextWarning {
  constructor(public path: string, public message: string) {}
  toString(): string { return `[context] ${this.path}: ${this.message}`; }
}

type WarnFn = (path: string, msg: string) => void;

export function validateContext(
  ctx: unknown,
  { logger }: { logger?: { warn: (msg: string) => void } } = {},
): ContextWarning[] {
  const warnings: ContextWarning[] = [];
  const warn: WarnFn = (path, msg) => warnings.push(new ContextWarning(path, msg));

  if (!ctx || typeof ctx !== 'object') {
    warn('context', 'missing or not an object');
    return warnings;
  }

  const c = ctx as Record<string, unknown>;
  validateAgreements(c['agreements'], warn);
  validateAgents(c['agents'], warn);
  validateHistory(c['history'], warn);
  validateUsers(c['users'], warn);

  if (logger && warnings.length > 0) {
    for (const w of warnings) logger.warn(w.toString());
  }
  return warnings;
}

function validateAgreements(agreements: unknown, warn: WarnFn): void {
  if (!Array.isArray(agreements)) return;
  for (let i = 0; i < agreements.length; i++) {
    const ag = agreements[i] as Record<string, unknown>;
    const path = `agreements[${i}]`;
    if (!ag || typeof ag !== 'object') { warn(path, 'not an object'); continue; }
    for (const key of ['agreementId', 'parties']) {
      if (ag[key] == null) warn(`${path}.${key}`, 'missing');
    }
    if (ag['parties'] && typeof ag['parties'] === 'object') {
      const parties = ag['parties'] as Record<string, unknown>;
      // Each side is occupied when either column names somebody; a side with a
      // principal and no actor is a party acting through its own credential.
      for (const key of ['creator', 'provider']) {
        const side = parties[key] as { principal?: unknown; actor?: unknown } | undefined;
        if (!side?.principal && !side?.actor) warn(`${path}.parties.${key}`, 'missing');
      }
    }
    if (ag['proposal'] && typeof ag['proposal'] === 'object') {
      if (!(ag['proposal'] as Record<string, unknown>)['status']) warn(`${path}.proposal.status`, 'missing');
    }
    if (ag['task'] && typeof ag['task'] === 'object') {
      const t = ag['task'] as Record<string, unknown>;
      if (!t['taskId']) warn(`${path}.task.taskId`, 'missing');
      if (!t['state']) warn(`${path}.task.state`, 'missing');
    }
  }
}

function validateAgents(agents: unknown, warn: WarnFn): void {
  if (!Array.isArray(agents)) return;
  let youCount = 0;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i] as Record<string, unknown>;
    const path = `agents[${i}]`;
    if (!agent || typeof agent !== 'object') { warn(path, 'not an object'); continue; }
    if (!agent['agentId']) warn(`${path}.agentId`, 'missing');
    if (agent['isYou']) youCount++;
  }
  if (agents.length > 0 && youCount === 0) warn('agents', 'no agent has isYou=true — agent identity will be unknown');
  if (youCount > 1) warn('agents', `${youCount} agents have isYou=true — should be exactly 1`);
}

function validateHistory(history: unknown, warn: WarnFn): void {
  if (!Array.isArray(history)) return;
  for (let i = 0; i < history.length; i++) {
    const entry = history[i] as Record<string, unknown>;
    const path = `history[${i}]`;
    if (!entry || typeof entry !== 'object') { warn(path, 'not an object'); continue; }
    if (!entry['entryType'] && entry['entryType'] !== 0) warn(`${path}.entryType`, 'missing');
    if (entry['entryType'] === 'message' && !entry['sender']) warn(`${path}.sender`, 'missing for message entry');
    if (entry['entryType'] === 'task_history') {
      const svc = entry['service'] as Record<string, unknown> | undefined;
      if (!svc?.['task']) warn(`${path}.service.task`, 'missing for task_history entry');
    }
  }
}

function validateUsers(users: unknown, warn: WarnFn): void {
  if (!Array.isArray(users)) return;
  for (let i = 0; i < users.length; i++) {
    const user = users[i] as Record<string, unknown>;
    const path = `users[${i}]`;
    if (!user || typeof user !== 'object') { warn(path, 'not an object'); continue; }
    if (!user['userId']) warn(`${path}.userId`, 'missing');
  }
}
