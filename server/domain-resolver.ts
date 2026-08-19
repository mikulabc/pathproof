import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { parseHttpUrl, resolveSafeTarget, TargetBlockedError, type SafeTarget } from './security.js';

const DEFAULT_PROBE_TIMEOUT_MS = 2_500;
const MAX_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 4;
const MAX_REDIRECTS = 8;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class DomainResolutionError extends Error {
  readonly code = 'DOMAIN_UNREACHABLE';

  constructor() {
    super("We couldn't recognize that domain. Check it and try again.");
    this.name = 'DomainResolutionError';
  }
}

class UnsafeRedirectError extends Error {}
class RedirectLimitError extends Error {}

export interface DomainProbeResponse {
  statusCode: number;
  location?: string;
}

export type DomainProbe = (target: SafeTarget, timeoutMs: number) => Promise<DomainProbeResponse>;
export type SafeTargetResolver = (input: string) => Promise<SafeTarget>;

export interface DomainResolverOptions {
  probeTimeoutMs?: number;
  maxRedirects?: number;
  probe?: DomainProbe;
  safeTargetResolver?: SafeTargetResolver;
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}

function withoutScheme(input: string): boolean {
  return !/^[a-z][a-z\d+.-]*:\/\//i.test(input) && !input.startsWith('//');
}

function candidateOrigins(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > 2_048) throw new DomainResolutionError();

  try {
    if (!withoutScheme(trimmed)) return [parseHttpUrl(trimmed).origin];
    return [
      parseHttpUrl(`https://${trimmed}`).origin,
      parseHttpUrl(`http://${trimmed}`).origin,
    ];
  } catch {
    throw new DomainResolutionError();
  }
}

function hostnameWithoutBrackets(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

async function probeAddress(target: SafeTarget, address: string, timeoutMs: number): Promise<DomainProbeResponse> {
  const isHttps = target.url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const hostname = hostnameWithoutBrackets(target.url);

  return new Promise<DomainProbeResponse>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      operation();
    };
    const request = transport.request({
      protocol: target.url.protocol,
      hostname: address,
      port: target.url.port || (isHttps ? 443 : 80),
      method: 'GET',
      path: `${target.url.pathname}${target.url.search}`,
      headers: {
        Host: target.url.host,
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'User-Agent': 'Pathproof domain resolver/1.0',
      },
      ...(isHttps && net.isIP(hostname) === 0 ? { servername: hostname } : {}),
    }, (response) => {
      const rawLocation = response.headers.location;
      finish(() => resolve({
        statusCode: response.statusCode ?? 0,
        location: Array.isArray(rawLocation) ? rawLocation[0] : rawLocation,
      }));
      response.destroy();
    });

    request.setTimeout(timeoutMs, () => request.destroy(new Error('Domain probe timed out.')));
    request.on('error', (error) => finish(() => reject(error)));
    request.end();
  });
}

export const probeSafeTarget: DomainProbe = async (target, timeoutMs) => {
  let lastError: unknown;
  const deadline = Date.now() + timeoutMs;

  for (const { address } of target.addresses) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    try {
      return await probeAddress(target, address, Math.min(remainingMs, 1_500));
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('The domain probe did not return a response.');
};

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Domain resolution timed out.')), timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function followRedirects(
  initial: SafeTarget,
  deadline: number,
  maxRedirects: number,
  probe: DomainProbe,
  safeTargetResolver: SafeTargetResolver,
): Promise<string> {
  let target = initial;

  for (let redirectCount = 0; ; redirectCount += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('Domain probe timed out.');
    const result = await probe(target, remainingMs);
    if (!REDIRECT_STATUSES.has(result.statusCode) || !result.location) return target.url.origin;
    if (redirectCount >= maxRedirects) throw new RedirectLimitError();

    let redirectUrl: URL;
    try {
      redirectUrl = new URL(result.location, target.url);
    } catch {
      throw new UnsafeRedirectError();
    }

    try {
      target = await withTimeout(safeTargetResolver(redirectUrl.href), Math.max(1, deadline - Date.now()));
    } catch {
      throw new UnsafeRedirectError();
    }
  }
}

/**
 * Turns a user-entered domain into a safe canonical HTTP origin. Scheme-less
 * inputs prefer HTTPS, then HTTP. Redirect targets are DNS-checked before a
 * socket is opened, and the request is pinned to the checked address.
 */
export async function resolveProjectOrigin(input: string, options: DomainResolverOptions = {}): Promise<string> {
  const timeoutMs = clampInteger(options.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS, 100, MAX_PROBE_TIMEOUT_MS);
  const maxRedirects = clampInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, MAX_REDIRECTS);
  const probe = options.probe ?? probeSafeTarget;
  const safeTargetResolver = options.safeTargetResolver ?? resolveSafeTarget;
  const candidates = candidateOrigins(input);
  let safeFallback: string | undefined;
  let unsafeRedirect = false;

  for (const candidate of candidates) {
    let initial: SafeTarget;
    try {
      initial = await withTimeout(safeTargetResolver(candidate), timeoutMs);
    } catch (error) {
      if (error instanceof TargetBlockedError) continue;
      continue;
    }

    safeFallback ??= initial.url.origin;

    // Redirect discovery is useful for public website origins. Custom ports are
    // commonly private app environments and keep the validated input as-is.
    if (initial.url.port) return initial.url.origin;

    try {
      return await followRedirects(initial, Date.now() + timeoutMs, maxRedirects, probe, safeTargetResolver);
    } catch (error) {
      if (error instanceof UnsafeRedirectError || error instanceof RedirectLimitError) unsafeRedirect = true;
      // Connection and TLS failures are best-effort: try the next scheme, then
      // retain the DNS-validated origin for compatibility with offline targets.
    }
  }

  if (safeFallback && !unsafeRedirect) return safeFallback;
  throw new DomainResolutionError();
}
