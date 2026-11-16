import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  answerDeprecationMessage,
  answerDeprecationWarning,
  printAnswerDeprecation,
} from '../commands/answer/deprecation.js';

describe('answer deprecation notice', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the sunset date, replacement and guide', () => {
    const msg = answerDeprecationMessage();
    expect(msg).toContain('2026-12-17');
    expect(msg).toContain('valyu deepresearch create "<question>" --mode instant --watch');
    expect(msg).toContain(
      'https://docs.valyu.ai/api-reference/endpoint/answer#migrate-from-answer',
    );
  });

  it('writes to stderr and never to stdout', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    printAnswerDeprecation();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toContain('is deprecated and stops working on 2026-12-17');
    expect(log).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
  });

  it('builds a JSON warning entry', () => {
    expect(answerDeprecationWarning()).toEqual({
      type: 'deprecation',
      message: answerDeprecationMessage(),
    });
  });
});
