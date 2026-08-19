import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunCoordinator } from '../../server/runner';
import { JsonStore } from '../../server/store';
import type { Project, Run, TestDefinition } from '../../src/shared';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('run execution controls', () => {
  it('pauses, resumes, and stops a queued run without marking it as failed', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pathproof-run-control-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const store = new JsonStore(path.join(directory, 'database.json'));
    await store.initialize();
    const project: Project = { id: 'project-control', name: 'Controls', origin: 'https://example.com', createdAt: new Date().toISOString(), status: 'ready' };
    const test: TestDefinition = {
      id: 'test-control', projectId: project.id, name: 'Controlled replay', seedUrls: ['https://example.com'], status: 'ready', coverage: 100,
      createdAt: new Date().toISOString(), plan: { version: 1, pages: ['https://example.com'], steps: [], generatedBy: 'browser-recording' },
    };
    const run: Run = {
      id: 'run-control', projectId: project.id, testId: test.id, kind: 'replay', aiUsed: false, status: 'queued', progress: 0,
      currentAction: 'Waiting for an available browser', createdAt: new Date().toISOString(), events: [], frameVersion: 0,
    };
    await store.mutate((database) => { database.projects.push(project); database.tests.push(test); database.runs.push(run); });
    const coordinator = new RunCoordinator(store, 1);

    expect(await coordinator.pauseRun(run.id)).toMatchObject({ status: 'queued', controlState: 'paused', currentAction: 'Paused' });
    expect(await coordinator.resumeRun(run.id)).toMatchObject({ status: 'queued', controlState: 'running', currentAction: 'Waiting for an available browser' });

    (coordinator as unknown as { active: number }).active = coordinator.capacity;
    coordinator.enqueue({ runId: run.id, testId: test.id });
    const stopped = await coordinator.stopRun(run.id);
    expect(stopped).toMatchObject({ status: 'interrupted', currentAction: 'Run stopped', error: 'Stopped by user.' });
    expect(store.snapshot().tests[0]).toMatchObject({ status: 'ready' });
  });
});
