import type { Command } from 'commander';
import {
  createTask,
  getTask,
  listTasks,
  updateTaskState,
} from '@ziggs-ai/api-client';
import type { Task, TaskState } from '@ziggs-ai/api-client';
import { loadCreds } from '../creds.js';
import { print, handleError } from '../output.js';

export function formatTaskLine(task: Task): string {
  const label = task.title?.trim() || task.description.replace(/\s+/g, ' ').slice(0, 80);
  return `  ${task.taskId}  ${task.state}  ${label}`;
}

export function registerTasksCommands(program: Command): void {
  const tasks = program.command('tasks').description('Task lifecycle');

  tasks
    .command('list')
    .description('List tasks this delegate can reach')
    .option('--state <state>', 'active, completed, failed, cancelled')
    .option('--mine', 'Only tasks assigned to this agent')
    .option('--limit <n>', 'Max rows', parseInt)
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const result = await listTasks(
          {
            state: opts.state as string | undefined,
            limit: opts.limit as number | undefined,
            assignedTo: opts.mine ? 'self' : undefined,
          },
          creds,
        );
        if (json) {
          print(result, true);
          return;
        }
        if (result.tasks.length === 0) {
          console.log('No tasks found.');
          return;
        }
        console.log(`${result.tasks.length} task(s):`);
        for (const task of result.tasks) console.log(formatTaskLine(task));
      } catch (err) {
        handleError(err, json);
      }
    });

  tasks
    .command('get <taskId>')
    .description('Fetch one task')
    .action(async (taskId: string) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const task = await getTask(taskId, creds);
        if (json) print(task, true);
        else console.log(formatTaskLine(task));
      } catch (err) {
        handleError(err, json);
      }
    });

  tasks
    .command('create')
    .description('Create a task under an agreement')
    .requiredOption('--agreement <agreementId>', 'Agreement the task belongs to')
    .requiredOption('--desc <description>', 'What the task is')
    .option('--title <title>', 'Short list label')
    .option('--assignee <id>', 'Who does it')
    .action(async (opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const creds = loadCreds();
      try {
        const task = await createTask(
          {
            agreementId: opts.agreement as string,
            description: opts.desc as string,
            title: opts.title as string | undefined,
            assigneeId: opts.assignee as string | undefined,
          },
          creds,
        );
        if (json) print(task, true);
        else console.log(`Task created: ${task.taskId}`);
      } catch (err) {
        handleError(err, json);
      }
    });

  tasks
    .command('set-result <taskId>')
    .description('File a completed or failed result. Cancelling is not a result.')
    .requiredOption('--state <state>', 'completed or failed')
    .option('--summary <text>', 'What the result is')
    .option('--error <text>', 'Why it failed')
    .action(async (taskId: string, opts) => {
      const json = (program.opts().json as boolean) ?? false;
      const state = opts.state as string;
      if (state !== 'completed' && state !== 'failed') {
        console.error('Error: --state must be "completed" or "failed"');
        process.exit(1);
      }
      const creds = loadCreds();
      try {
        const confirm = await updateTaskState(
          taskId,
          state as TaskState,
          {
            result: opts.summary ? { summary: opts.summary as string } : undefined,
            errorMessage: opts.error as string | undefined,
          },
          creds,
        );
        if (json) print(confirm, true);
        else console.log(`Task ${taskId} → ${confirm.state ?? state}`);
      } catch (err) {
        handleError(err, json);
      }
    });
}
