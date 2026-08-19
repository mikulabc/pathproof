import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLocalEnvironment } from '../../server/environment';

const variable = 'PATHPROOF_ENV_LOADING_TEST';
const originalValue = process.env[variable];
const directories: string[] = [];

afterEach(async () => {
  if (originalValue === undefined) delete process.env[variable];
  else process.env[variable] = originalValue;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('local environment loading', () => {
  it('loads server configuration from an env file', async () => {
    delete process.env[variable];
    const directory = await mkdtemp(path.join(tmpdir(), 'pathproof-env-'));
    directories.push(directory);
    const environmentPath = path.join(directory, '.env');
    await writeFile(environmentPath, `${variable}=from-file\n`);

    loadLocalEnvironment(environmentPath);

    expect(process.env[variable]).toBe('from-file');
  });

  it('preserves an explicitly exported environment value', async () => {
    process.env[variable] = 'from-shell';
    const directory = await mkdtemp(path.join(tmpdir(), 'pathproof-env-'));
    directories.push(directory);
    const environmentPath = path.join(directory, '.env');
    await writeFile(environmentPath, `${variable}=from-file\n`);

    loadLocalEnvironment(environmentPath);

    expect(process.env[variable]).toBe('from-shell');
  });
});
