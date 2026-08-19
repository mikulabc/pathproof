import { describe, expect, it, vi } from 'vitest';
import {
  DomainResolutionError,
  resolveProjectOrigin,
  type DomainProbe,
  type SafeTargetResolver,
} from '../../server/domain-resolver';
import { TargetBlockedError, type SafeTarget } from '../../server/security';

function publicTarget(input: string): SafeTarget {
  return { url: new URL(input), addresses: [{ address: '203.1.1.10', family: 4 }] };
}

describe('project domain resolution', () => {
  it('prefers HTTPS and returns the final safe redirect origin', async () => {
    const checked: string[] = [];
    const safeTargetResolver: SafeTargetResolver = vi.fn(async (input) => {
      checked.push(input);
      return publicTarget(input);
    });
    const probe: DomainProbe = vi.fn(async (target) => target.url.hostname === 'example.com'
      ? { statusCode: 301, location: 'https://www.example.com/welcome' }
      : { statusCode: 200 });

    await expect(resolveProjectOrigin('example.com', { probe, safeTargetResolver }))
      .resolves.toBe('https://www.example.com');
    expect(checked).toEqual([
      'https://example.com',
      'https://www.example.com/welcome',
    ]);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('falls back to HTTP when a scheme-less HTTPS target cannot be reached', async () => {
    const safeTargetResolver: SafeTargetResolver = async (input) => publicTarget(input);
    const probe: DomainProbe = async (target) => {
      if (target.url.protocol === 'https:') throw new Error('TLS unavailable');
      return { statusCode: 200 };
    };

    await expect(resolveProjectOrigin('example.com', { probe, safeTargetResolver }))
      .resolves.toBe('http://example.com');
  });

  it('keeps a DNS-safe origin when the optional probe is unavailable', async () => {
    const safeTargetResolver: SafeTargetResolver = async (input) => publicTarget(input);
    const probe: DomainProbe = async () => { throw new Error('Connection refused'); };

    await expect(resolveProjectOrigin('offline.example', { probe, safeTargetResolver }))
      .resolves.toBe('https://offline.example');
  });

  it('checks every redirect before requesting it and rejects private destinations', async () => {
    const probed: string[] = [];
    const safeTargetResolver: SafeTargetResolver = async (input) => {
      const url = new URL(input);
      if (url.hostname === '127.0.0.1') throw new TargetBlockedError('private destination');
      return publicTarget(input);
    };
    const probe: DomainProbe = async (target) => {
      probed.push(target.url.href);
      return { statusCode: 302, location: 'http://127.0.0.1/admin' };
    };

    await expect(resolveProjectOrigin('redirect.example', { probe, safeTargetResolver }))
      .rejects.toBeInstanceOf(DomainResolutionError);
    expect(probed).toEqual(['https://redirect.example/', 'http://redirect.example/']);
    expect(probed).not.toContain('http://127.0.0.1/admin');
  });

  it('uses a friendly error for malformed input', async () => {
    await expect(resolveProjectOrigin('https://'))
      .rejects.toMatchObject({
        code: 'DOMAIN_UNREACHABLE',
        message: "We couldn't recognize that domain. Check it and try again.",
      });
  });
});
