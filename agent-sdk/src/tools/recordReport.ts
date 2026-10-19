import {
  ArtifactsClient,
  updateTaskState,
  type Creds,
} from '@ziggs-ai/api-client';

/**
 * The canonical report shape (B1 convention).
 * Matches Task.result as set by ziggs_task_set_result.
 */
export interface TaskReport {
  summary: string;
  status?: string;
  links?: string[];
}

export interface RecordReportInput {
  creds: Creds;
  taskId: string;
  report: TaskReport;
  /**
   * Optional container for the deliverable artifact (it used to be
   * required). The task binding is what makes the deliverable retrievable and
   * readable by the task's parties; a chat or agreement only widens where it also
   * shows up. Pass at most one; when both arrive, agreementId wins.
   */
  chatId?: string;
  agreementId?: string;
  /**
   * Heavy deliverable text (document, diff, data).
   * When present, writes a `contentType=result` artifact bound to the task
   * alongside setting Task.result.
   */
  deliverable?: string;
}

export interface RecordReportResult {
  taskId: string;
  artifactId?: string;
}

/**
 * Record a conformant report for a completed task (B2).
 *
 * Always sets Task.result via updateTaskState (the canonical done payload).
 * When `deliverable` is provided, also writes a task-bound result artifact
 * via ArtifactsClient so it is retrievable as `via=task:<taskId>`.
 *
 * One deliverable per task: the idempotency key is `task-result:<taskId>`.
 * A retry after a partial failure reuses that row (intentional). A later
 * revision of the same task still returns the original artifact — change the
 * key if you mean a new deliverable; do not change this helper's key.
 *
 * Implements the B1 convention (Agents/REPORTING.md).
 */
export async function recordReport(
  input: RecordReportInput,
): Promise<RecordReportResult> {
  const { creds, taskId, report, chatId, agreementId, deliverable } = input;

  // no container needed. The deliverable is bound to its task, which
  // is what makes it retrievable as `via=task:<taskId>` and readable by the
  // task's parties — a chat or agreement was never what made that work.
  //
  // the agreement still wins here, and this is now the ONE place that
  // resolves rather than refuses — deliberately, because the caller is not a
  // model choosing arguments. `recordReport` is handed both ids by the runtime
  // (the task's agreement and the chat it is running in), so there is no
  // mistake to surface and nobody to retry: refusing would fail a finished
  // task's delivery over a pair of ids it did not choose.
  const scope = agreementId ? { agreementId } : chatId ? { chatId } : {};

  // Deliverable FIRST, then close the task.
  //
  // The old order completed the task and then wrote the artifact with the
  // soft-failing `write`, so a wire error left a task marked completed whose
  // deliverable had silently vanished. Recording first means a failure here
  // leaves the task open — the honest state, and one a retry can finish. The
  // idempotency key is derived from the task, so that retry reuses the artifact
  // row instead of recording the deliverable twice.
  let artifactId: string | undefined;
  if (deliverable) {
    const artifactsClient = new ArtifactsClient(
      creds.operatorKey,
      creds.agentId,
    );
    ({ artifactId } = await artifactsClient.writeStrict({
      text: deliverable,
      contentType: 'result',
      taskId,
      ...scope,
      visibility: 'chat',
      // Deterministic, not random: one deliverable per task, so a replay of this
      // whole function reproduces the key and dedups server-side.
      idempotencyKey: `task-result:${taskId}`,
    }));
  }

  await updateTaskState(
    taskId,
    'completed',
    { result: { summary: report.summary, status: report.status ?? 'ok', links: report.links ?? [] } },
    creds,
  );

  // The artifactId was being discarded even though RecordReportResult declares
  // it — the caller had no way to reference the deliverable it just recorded.
  return artifactId ? { taskId, artifactId } : { taskId };
}
