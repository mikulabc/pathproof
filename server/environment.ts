import path from 'node:path';
import { loadEnvFile } from 'node:process';

export function loadLocalEnvironment(environmentPath = path.resolve(process.cwd(), '.env')): void {
  try {
    loadEnvFile(environmentPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
