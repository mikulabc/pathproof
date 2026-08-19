import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../server/store';
import { JsonStore } from '../../server/store';

describe('store migrations', () => {
  it('invalidates legacy instruction-driven baselines that were saved without AI', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pathproof-store-'));
    const filePath = path.join(directory, 'pathproof.json');
    const now = new Date().toISOString();
    const database: Database = {
      version: 1,
      projects: [{ id: 'project', name: 'Project', origin: 'https://example.com', status: 'ready', createdAt: now }],
      tests: [{
        id: 'test', projectId: 'project', name: 'Instructions', seedUrls: ['https://example.com'],
        aiInstructions: 'Open Restaurants.', status: 'ready', coverage: 47, createdAt: now, lastRunId: 'run',
        plan: { version: 1, pages: ['https://example.com'], generatedBy: 'local-smart-discovery', steps: [] },
      }],
      runs: [{
        id: 'run', projectId: 'project', testId: 'test', kind: 'discovery', aiUsed: false,
        status: 'passed', progress: 100, createdAt: now, completedAt: now, currentAction: 'Run complete', frameVersion: 0,
        events: [
          { id: 'warning', runId: 'run', at: now, type: 'warning', label: 'AI instruction planning stopped', status: 'skipped' },
          { id: 'complete', runId: 'run', at: now, type: 'complete', label: 'All checks passed', status: 'passed' },
        ],
      }],
    };
    await writeFile(filePath, JSON.stringify(database));

    try {
      const store = new JsonStore(filePath);
      await store.initialize();
      const migrated = store.snapshot();

      expect(migrated.tests[0]).toMatchObject({ status: 'failed', coverage: 0 });
      expect(migrated.tests[0].plan).toBeUndefined();
      expect(migrated.runs[0]).toMatchObject({
        status: 'failed', progress: 99, currentAction: 'Run failed',
        error: expect.stringContaining('finished without AI'),
      });
      expect(migrated.runs[0].events.at(-1)).toMatchObject({
        type: 'complete', status: 'failed', label: 'Failed: incomplete AI instruction setup',
      });
      expect(migrated.projects[0].status).toBe('attention');
      expect(JSON.parse(await readFile(filePath, 'utf8')).tests[0].plan).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
