import { describe, expect, test } from '@jest/globals';
import { parseQuotaRetry, parseResetDurationMs } from '@/common/rebuildchat/quotaRetryParser';

describe('quotaRetryParser', () => {
  test('parses reset duration with hours minutes and seconds', () => {
    expect(parseResetDurationMs('Error: Individual quota reached. Resets in 3h22m26s.')).toBe(12146000);
    expect(parseResetDurationMs('Resets in 2m13s')).toBe(133000);
    expect(parseResetDurationMs('Resets in 14s')).toBe(14000);
  });

  test('returns retry directive with parsed reset time', () => {
    const result = parseQuotaRetry({
      now: 1000,
      output: 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 14s.',
    });

    expect(result.matched).toBe(true);
    expect(result.directive).toEqual({
      reason: 'quota',
      retryAt: 25000,
      retryDelayMs: 24000,
      matchedText: 'Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 14s.',
      source: 'output',
    });
  });

  test('falls back to five minute retry when reset time is missing', () => {
    const result = parseQuotaRetry({
      now: 2000,
      rawLog: 'Rate limit reached. Please upgrade your subscription to increase your limits.',
    });

    expect(result.directive?.retryDelayMs).toBe(300000);
    expect(result.directive?.retryAt).toBe(302000);
    expect(result.directive?.source).toBe('rawLog');
  });

  test('does not match unrelated output', () => {
    const result = parseQuotaRetry({
      output: 'Everything completed successfully.',
      rawLog: 'No rate limits here.',
    });

    expect(result).toEqual({
      matched: false,
      directive: null,
    });
  });
});
