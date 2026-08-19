import dns from 'node:dns/promises';
import net from 'node:net';

export class TargetBlockedError extends Error {
  readonly code = 'TARGET_BLOCKED';

  constructor(message: string) {
    super(message);
    this.name = 'TargetBlockedError';
  }
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('ff')) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function isLoopback(address: string): boolean {
  if (address === '::1') return true;
  if (net.isIPv4(address)) return address.startsWith('127.');
  return /^::ffff:127\./i.test(address);
}

export interface SafeTarget {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}

function hostnameForLookup(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function parseHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TargetBlockedError('A valid absolute URL is required.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TargetBlockedError('Only HTTP and HTTPS targets are supported.');
  }
  if (url.username || url.password) throw new TargetBlockedError('URLs containing credentials are not allowed.');
  url.hash = '';
  return url;
}

export async function resolveSafeTarget(input: string): Promise<SafeTarget> {
  const url = parseHttpUrl(input);
  const hostname = hostnameForLookup(url);
  const allowLocalhost = process.env.PATHPROOF_ALLOW_LOCALHOST === '1';
  const explicitlyLocal = hostname === 'localhost' || hostname.endsWith('.localhost') || isLoopback(hostname);

  if (explicitlyLocal && !allowLocalhost) {
    throw new TargetBlockedError('Localhost targets are disabled.');
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new TargetBlockedError(`The target hostname could not be resolved: ${hostname}`);
  }

  if (addresses.length === 0) throw new TargetBlockedError(`The target hostname could not be resolved: ${hostname}`);
  for (const { address } of addresses) {
    if (!isPrivateAddress(address)) continue;
    if (!(allowLocalhost && explicitlyLocal && isLoopback(address))) {
      throw new TargetBlockedError(`Private or reserved network targets are not allowed: ${hostname}`);
    }
  }
  return { url, addresses };
}

export async function assertSafeTarget(input: string): Promise<URL> {
  return (await resolveSafeTarget(input)).url;
}

export function sameOrigin(left: string, right: string): boolean {
  return parseHttpUrl(left).origin === parseHttpUrl(right).origin;
}
