import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Project, Run, TestDefinition } from '../src/shared.js';

export interface Database {
  version: 1;
  projects: Project[];
  tests: TestDefinition[];
  runs: Run[];
}

const EMPTY_DATABASE: Database = { version: 1, projects: [], tests: [], runs: [] };
const INCOMPLETE_INSTRUCTION_SETUP = 'Instruction-driven setup finished without AI and did not record the requested journey. Create a replacement setup.';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cleanRuntimeText(value: string | undefined): string | undefined {
  return value?.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').trim();
}

export class JsonStore {
  private data: Database = clone(EMPTY_DATABASE);
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = path.resolve(process.cwd(), '.data', 'pathproof.json')) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<Database>;
      if (parsed.version !== 1 || !Array.isArray(parsed.projects) || !Array.isArray(parsed.tests) || !Array.isArray(parsed.runs)) {
        throw new Error('Unsupported or invalid database shape.');
      }
      this.data = parsed as Database;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.persist(this.data);
    }

    await this.mutate((database) => {
      const now = new Date().toISOString();
      for (const run of database.runs) {
        run.controlState = undefined;
        if (run.status === 'failed' && run.progress >= 100) run.progress = 99;
        run.error = cleanRuntimeText(run.error);
        run.actual = cleanRuntimeText(run.actual);
        for (const runEvent of run.events) runEvent.actual = cleanRuntimeText(runEvent.actual);
        if (run.status !== 'queued' && run.status !== 'running') continue;
        run.status = 'interrupted';
        run.completedAt = now;
        run.error = 'The server stopped before this run completed.';
        run.currentAction = 'Interrupted';
      }
      for (const test of database.tests) {
        const hasLegacyInstructionPlan = Boolean(test.aiInstructions?.trim() && test.plan?.generatedBy === 'local-smart-discovery');
        const hasLegacyPlannerWarning = Boolean(test.aiInstructions?.trim() && database.runs.some((run) =>
          run.testId === test.id && run.kind === 'discovery' && !run.aiUsed
          && run.events.some((runEvent) => runEvent.label === 'AI instruction planning stopped'),
        ));
        if (hasLegacyInstructionPlan || hasLegacyPlannerWarning) {
          test.plan = undefined;
          test.coverage = 0;
          test.status = 'failed';
          for (const run of database.runs.filter((candidate) => candidate.testId === test.id && candidate.status === 'passed')) {
            run.status = 'failed';
            run.progress = Math.min(run.progress, 99);
            run.currentAction = 'Run failed';
            run.error = INCOMPLETE_INSTRUCTION_SETUP;
            run.expected = 'AI follows and records the supplied instructions.';
            run.actual = INCOMPLETE_INSTRUCTION_SETUP;
            const completion = [...run.events].reverse().find((runEvent) => runEvent.type === 'complete');
            if (completion) {
              completion.label = 'Failed: incomplete AI instruction setup';
              completion.status = 'failed';
              completion.expected = run.expected;
              completion.actual = INCOMPLETE_INSTRUCTION_SETUP;
            }
          }
        }
        if (test.status === 'discovering') test.status = test.plan ? 'ready' : 'failed';
      }
      this.recomputeProjects(database);
    });
  }

  snapshot(): Database {
    return clone(this.data);
  }

  async mutate<T>(operation: (database: Database) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.writeChain = this.writeChain.then(async () => {
      const candidate = clone(this.data);
      try {
        const operationResult = await operation(candidate);
        await this.persist(candidate);
        this.data = candidate;
        resolveResult(clone(operationResult));
      } catch (error) {
        rejectResult(error);
      }
    });
    await this.writeChain;
    return result;
  }

  recomputeProjects(database: Database): void {
    for (const project of database.projects) {
      const tests = database.tests.filter((test) => test.projectId === project.id);
      const runs = database.runs
        .filter((run) => run.projectId === project.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      if (runs.some((run) => run.status === 'queued' || run.status === 'running')) project.status = 'running';
      else if (tests.some((test) => test.status === 'failed') || runs[0]?.status === 'failed') project.status = 'attention';
      else if (tests.some((test) => test.plan)) project.status = 'ready';
      else project.status = 'empty';
      const completed = runs.find((run) => run.completedAt);
      project.lastRunAt = completed?.completedAt;
    }
  }

  private async persist(database: Database): Promise<void> {
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.filePath);
  }
}
