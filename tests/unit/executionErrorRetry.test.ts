import { describe, expect, test } from '@jest/globals';
import { DEFAULT_EXECUTION_ERROR_RETRY_COUNT_INPUT, getExecutionErrorRetryValidationMessage, parseExecutionErrorRetryCount } from '@/common/rebuildchat/executionErrorRetry';

describe('executionErrorRetry', () => {
  test('exposes the default retry count input', () => {
    expect(DEFAULT_EXECUTION_ERROR_RETRY_COUNT_INPUT).toBe('1');
  });

  test('parses zero and positive integer retry counts', () => {
    expect(parseExecutionErrorRetryCount('0')).toEqual({
      value: 0,
      error: null,
    });
    expect(parseExecutionErrorRetryCount('3')).toEqual({
      value: 3,
      error: null,
    });
  });

  test('rejects empty, invalid, and negative retry counts', () => {
    expect(parseExecutionErrorRetryCount('')).toEqual({
      value: null,
      error: 'empty',
    });
    expect(parseExecutionErrorRetryCount('abc')).toEqual({
      value: null,
      error: 'invalid',
    });
    expect(parseExecutionErrorRetryCount('-1')).toEqual({
      value: null,
      error: 'negative',
    });
  });

  test('returns user-facing validation messages', () => {
    expect(getExecutionErrorRetryValidationMessage('empty')).toBe('普通错误自动重试次数必须填写 0 或正整数。');
    expect(getExecutionErrorRetryValidationMessage('invalid')).toBe('普通错误自动重试次数必须填写 0 或正整数。');
    expect(getExecutionErrorRetryValidationMessage('negative')).toBe('普通错误自动重试次数不能小于 0。');
  });
});
