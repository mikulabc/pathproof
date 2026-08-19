import { afterEach, describe, expect, it, vi } from 'vitest';
import { planActionsWithAi, planNextActionWithAi } from '../../server/ai-planner';

const candidates = [
  { kind: 'click' as const, label: 'Open contact' },
  { kind: 'filter' as const, label: 'Filter catalog' },
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AI action planning fallback', () => {
  it('does not replace an instruction-driven goal with generic actions when AI is unavailable', async () => {
    vi.stubEnv('PATHPROOF_DISABLE_AI', '1');

    const result = await planActionsWithAi({
      url: 'https://example.com/',
      title: 'Example',
      candidates,
      instructions: 'Open the contact page.',
    });

    expect(result).toMatchObject({ actions: [], usedAi: false });
  });

  it('keeps local smart-discovery actions when no user goal was supplied', async () => {
    vi.stubEnv('PATHPROOF_DISABLE_AI', '1');

    const result = await planActionsWithAi({
      url: 'https://example.com/',
      title: 'Example',
      candidates,
    });

    expect(result).toMatchObject({ actions: candidates, usedAi: false });
  });

  it('stops an iterative instruction flow cleanly when AI is unavailable', async () => {
    vi.stubEnv('PATHPROOF_DISABLE_AI', '1');

    const result = await planNextActionWithAi({
      url: 'https://example.com/', title: 'Example', candidates,
      instructions: 'Hover over Gastronomie and open Restaurants.', history: [],
    });

    expect(result).toMatchObject({
      completed: false,
      usedAi: false,
      warning: 'AI is disabled by PATHPROOF_DISABLE_AI.',
    });
  });

  it('explains how to configure instruction-driven setup when no API key is available', async () => {
    vi.stubEnv('PATHPROOF_DISABLE_AI', '0');
    vi.stubEnv('OPENAI_API_KEY', '');

    const result = await planNextActionWithAi({
      url: 'https://example.com/', title: 'Example', candidates,
      instructions: 'Open the contact page.', history: [],
    });

    expect(result).toMatchObject({
      completed: false,
      usedAi: false,
      warning: 'AI is not configured. Set OPENAI_API_KEY in .env and restart Pathproof.',
    });
  });
});
