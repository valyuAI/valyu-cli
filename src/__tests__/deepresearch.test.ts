import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchResearch } from '../commands/deepresearch/index.js';

describe('watchResearch without a terminal', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hands back a paused checkpoint and how to answer it, instead of prompting', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = {
      getResearchStatus: vi.fn().mockResolvedValue({
        data: {
          deepresearch_id: 'dr_1',
          status: 'awaiting_input',
          messages: [{ role: 'assistant', content: 'transcript' }],
          interaction: { interaction_id: 'int_1', type: 'plan_review', data: { plan: 'p' } },
        },
        error: null,
      }),
    };

    await watchResearch(client as never, 'dr_1', { json: true, quiet: true });

    const out = JSON.parse(log.mock.calls[0][0] as string);
    expect(out.messages).toBeUndefined();
    expect(out.interaction.interaction_id).toBe('int_1');
    expect(out.hint).toContain("valyu deepresearch respond dr_1 --response '<json>'");
    expect(out.hint).toContain('{"approved": true}');
  });

  it('prints a completed report without the agent transcript', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = {
      getResearchStatus: vi.fn().mockResolvedValue({
        data: { deepresearch_id: 'dr_1', status: 'completed', output: '# Report', messages: ['x'] },
        error: null,
      }),
    };

    await watchResearch(client as never, 'dr_1', { json: true, quiet: true });

    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual({
      deepresearch_id: 'dr_1',
      status: 'completed',
      output: '# Report',
    });
  });
});
