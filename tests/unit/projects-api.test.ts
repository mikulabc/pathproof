import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainResolutionError } from '../../server/domain-resolver';
import { createApp } from '../../server/index';
import type { RunCoordinator } from '../../server/runner';
import { JsonStore } from '../../server/store';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startApi(originResolver: (input: string) => Promise<string>, exposeStore?: (store: JsonStore) => void): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'pathproof-project-api-'));
  const store = new JsonStore(path.join(directory, 'database.json'));
  const coordinator = {
    capacity: 1,
    initialize: async () => undefined,
    enqueue: vi.fn(),
    deleteRunArtifacts: vi.fn(async () => undefined),
  } as unknown as RunCoordinator;
  exposeStore?.(store);
  const { app } = await createApp({ store, coordinator, originResolver });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address() as AddressInfo;
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(baseUrl: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('project origin API', () => {
  it('resolves the input contract and persists the same canonical origin on create and patch', async () => {
    const originResolver = vi.fn(async (input: string) => input === 'example.com'
      ? 'https://example.com'
      : 'https://www.example.com');
    const baseUrl = await startApi(originResolver);

    const resolveResponse = await postJson(baseUrl, '/api/origins/resolve', { input: 'example.com' });
    expect(resolveResponse.status).toBe(200);
    expect(await resolveResponse.json()).toEqual({ origin: 'https://example.com' });

    const createResponse = await postJson(baseUrl, '/api/projects', { name: 'Acme Ltd.', domain: 'example.com' });
    expect(createResponse.status).toBe(201);
    const project = await createResponse.json() as { id: string; origin: string };
    expect(project.origin).toBe('https://example.com');

    const patchResponse = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'www.example.com' }),
    });
    expect(patchResponse.status).toBe(200);
    expect((await patchResponse.json() as { origin: string }).origin).toBe('https://www.example.com');
    expect(originResolver).toHaveBeenCalledWith('example.com');
    expect(originResolver).toHaveBeenCalledWith('www.example.com');
  });

  it('returns a stable friendly error without parser or hostname details', async () => {
    const baseUrl = await startApi(async () => { throw new DomainResolutionError(); });

    const response = await postJson(baseUrl, '/api/origins/resolve', { input: 'bad host' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'DOMAIN_UNREACHABLE',
        message: "We couldn't recognize that domain. Check it and try again.",
      },
    });
  });

  it('renames automated tests and their first-run setup even when setup has not completed', async () => {
    const baseUrl = await startApi(async (input) => input);
    const projectResponse = await postJson(baseUrl, '/api/projects', {
      name: 'Failed setup naming',
      origin: 'https://example.com',
    });
    const project = await projectResponse.json() as { id: string };
    const createResponse = await postJson(baseUrl, `/api/projects/${project.id}/tests`, {
      name: 'Original AI test',
      seedUrls: ['https://example.com/failing-setup'],
      aiInstructions: 'Inspect the page.',
    });
    expect(createResponse.status).toBe(202);
    const created = await createResponse.json() as { test: { id: string }; run: { id: string; kind: string } };
    expect(created.run.kind).toBe('discovery');

    const testRenameResponse = await fetch(`${baseUrl}/api/tests/${created.test.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed AI test' }),
    });
    expect(testRenameResponse.status).toBe(200);
    expect((await testRenameResponse.json() as { name: string }).name).toBe('Renamed AI test');

    const runRenameResponse = await fetch(`${baseUrl}/api/runs/${created.run.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Failed homepage setup' }),
    });
    expect(runRenameResponse.status).toBe(200);
    expect((await runRenameResponse.json() as { name: string }).name).toBe('Failed homepage setup');
  });

  it('stores supported replay speeds and rejects values outside quarter-step options', async () => {
    const baseUrl = await startApi(async (input) => input);
    const projectResponse = await postJson(baseUrl, '/api/projects', {
      name: 'Playback controls',
      origin: 'https://example.com',
    });
    const project = await projectResponse.json() as { id: string };
    const timestamp = new Date().toISOString();
    const importResponse = await postJson(baseUrl, `/api/projects/${project.id}/recordings`, {
      name: 'Checkout replay',
      recording: {
        format: 'pathproof-recording', version: 1, id: 'playback-fixture', name: 'Checkout replay',
        createdAt: timestamp, startedAt: timestamp, stoppedAt: timestamp, durationMs: 1_000,
        target: { initialUrl: 'https://example.com/checkout', finalUrl: 'https://example.com/checkout', title: 'Checkout' },
        browser: { viewport: { width: 1280, height: 720 }, locale: 'en-US' },
        events: [{ id: 'click-1', sequence: 1, at: timestamp, offsetMs: 500, kind: 'click', url: 'https://example.com/checkout', selector: '#pay', role: 'button', accessibleName: 'Pay' }],
      },
    });
    expect(importResponse.status).toBe(201);
    const imported = await importResponse.json() as { id: string };

    const slowResponse = await postJson(baseUrl, `/api/tests/${imported.id}/run`, { playbackSpeed: 0.25 });
    expect(slowResponse.status).toBe(202);
    expect(await slowResponse.json() as { playbackSpeed: number; name: string }).toMatchObject({ playbackSpeed: 0.25, name: 'Saved test replay 1' });

    const fastResponse = await postJson(baseUrl, `/api/tests/${imported.id}/runs`, { playbackSpeed: 2 });
    expect(fastResponse.status).toBe(202);
    const fastRun = await fastResponse.json() as { id: string; playbackSpeed: number; name: string };
    expect(fastRun.playbackSpeed).toBe(2);
    expect(fastRun.name).toBe('Saved test replay 2');

    const renameRunResponse = await fetch(`${baseUrl}/api/runs/${fastRun.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Production checkout replay' }),
    });
    expect(renameRunResponse.status).toBe(200);
    expect((await renameRunResponse.json() as { name: string }).name).toBe('Production checkout replay');

    const exportResponse = await fetch(`${baseUrl}/api/runs/${fastRun.id}/pathfinder-steps`);
    expect(exportResponse.status).toBe(200);
    const pathfinderFilename = exportResponse.headers.get('content-disposition') || '';
    expect(pathfinderFilename).toContain('Checkout-replay-Production-checkout-replay-');
    expect(pathfinderFilename).toContain(`-${fastRun.id.slice(0, 12)}-pathfinder-steps.json`);
    const exported = await exportResponse.json() as { format: string; test: { source: string }; steps: unknown[] };
    expect(exported.format).toBe('pathproof-pathfinder-steps');
    expect(exported.test.source).toBe('browser-recording');
    expect(exported.steps.length).toBeGreaterThan(1);

    const logsResponse = await fetch(`${baseUrl}/api/runs/${fastRun.id}/logs`);
    expect(logsResponse.status).toBe(200);
    const logsFilename = logsResponse.headers.get('content-disposition') || '';
    expect(logsFilename).toContain('Checkout-replay-Production-checkout-replay-');
    expect(logsFilename).toContain(`-${fastRun.id.slice(0, 12)}-run-logs.json`);
    const logs = await logsResponse.json() as {
      format: string;
      run: { id: string; name: string; kind: string; playbackSpeed: number };
      recordedBaseline: { generatedBy: string; steps: unknown[] };
      summary: { totalInteractions: number };
      interactions: Array<{ sequence: number; comparison: { expected: string | null; actual: string | null; result: string } }>;
    };
    expect(logs.format).toBe('pathproof-run-logs');
    expect(logs.run).toMatchObject({ id: fastRun.id, name: 'Production checkout replay', kind: 'replay', playbackSpeed: 2 });
    expect(logs.recordedBaseline.generatedBy).toBe('browser-recording');
    expect(logs.recordedBaseline.steps.length).toBeGreaterThan(1);
    expect(logs.summary.totalInteractions).toBe(logs.interactions.length);
    expect(logs.interactions[0]).toMatchObject({ sequence: 1, comparison: { expected: null, actual: null, result: 'not-compared' } });

    const bulkResponse = await postJson(baseUrl, '/api/runs/bulk', {
      testIds: [imported.id], playbackSpeeds: { [imported.id]: 1.75 },
    });
    expect(bulkResponse.status).toBe(202);
    expect((await bulkResponse.json() as { runs: Array<{ playbackSpeed: number; name: string }> }).runs[0]).toMatchObject({ playbackSpeed: 1.75, name: 'Saved test replay 3' });

    expect((await postJson(baseUrl, `/api/tests/${imported.id}/run`, { playbackSpeed: 0.3 })).status).toBe(400);
    expect((await postJson(baseUrl, `/api/tests/${imported.id}/run`, { playbackSpeed: 2.25 })).status).toBe(400);
  });

  it('deletes completed run history individually and in bulk while preserving the automated test', async () => {
    let store!: JsonStore;
    const baseUrl = await startApi(async (input) => input, (value) => { store = value; });
    const projectResponse = await postJson(baseUrl, '/api/projects', { name: 'Run history', origin: 'https://example.com' });
    const project = await projectResponse.json() as { id: string };
    const timestamp = new Date().toISOString();
    const importResponse = await postJson(baseUrl, `/api/projects/${project.id}/recordings`, {
      name: 'History fixture',
      recording: {
        format: 'pathproof-recording', version: 1, id: 'history-fixture', name: 'History fixture',
        createdAt: timestamp, startedAt: timestamp, stoppedAt: timestamp, durationMs: 500,
        target: { initialUrl: 'https://example.com/history', finalUrl: 'https://example.com/history' },
        browser: { viewport: { width: 1280, height: 720 } },
        events: [{ id: 'history-click', sequence: 1, at: timestamp, offsetMs: 250, kind: 'click', url: 'https://example.com/history', selector: '#continue', accessibleName: 'Continue' }],
      },
    });
    const imported = await importResponse.json() as { id: string };
    const runs = await Promise.all([1, 2, 3].map(async () => {
      const response = await postJson(baseUrl, `/api/tests/${imported.id}/run`, { playbackSpeed: 1 });
      return response.json() as Promise<{ id: string }>;
    }));

    expect((await fetch(`${baseUrl}/api/runs/${runs[0].id}`, { method: 'DELETE' })).status).toBe(409);
    await store.mutate((database) => {
      for (const run of database.runs) { run.status = 'passed'; run.progress = 100; run.currentAction = 'Run complete'; }
    });
    expect((await fetch(`${baseUrl}/api/runs/${runs[0].id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await fetch(`${baseUrl}/api/runs/${runs[0].id}`)).status).toBe(404);

    const bulkResponse = await postJson(baseUrl, '/api/runs/bulk-delete', { runIds: [runs[1].id, runs[2].id] });
    expect(bulkResponse.status).toBe(200);
    expect(await bulkResponse.json()).toEqual({ deleted: 2 });
    const testResponse = await fetch(`${baseUrl}/api/tests/${imported.id}`);
    expect(testResponse.status).toBe(200);
    expect((await testResponse.json() as { test: { id: string; lastRunId?: string }; runs: unknown[] })).toMatchObject({ test: { id: imported.id }, runs: [] });
  });
});
