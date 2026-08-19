import { describe, expect, it } from 'vitest';
import { parseHttpUrl, sameOrigin, TargetBlockedError } from '../../server/security';

describe('target URL safety primitives', () => {
  it('accepts only credential-free HTTP targets and removes fragments', () => {
    expect(parseHttpUrl('https://example.com/docs#private').href).toBe('https://example.com/docs');
    expect(() => parseHttpUrl('file:///etc/passwd')).toThrow(TargetBlockedError);
    expect(() => parseHttpUrl('https://user:secret@example.com')).toThrow(TargetBlockedError);
    expect(() => parseHttpUrl('not a URL')).toThrow(TargetBlockedError);
  });

  it('compares full origins, including scheme and port', () => {
    expect(sameOrigin('https://example.com/seed', 'https://example.com/child')).toBe(true);
    expect(sameOrigin('https://example.com', 'http://example.com')).toBe(false);
    expect(sameOrigin('http://example.com:4317', 'http://example.com:4318')).toBe(false);
  });
});
