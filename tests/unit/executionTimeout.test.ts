import { describe, expect, test } from '@jest/globals';
import { DEFAULT_EXECUTION_TIMEOUT_MINUTES_INPUT, getExecutionTimeoutMs, getExecutionTimeoutValidationMessage, parseExecutionTimeoutMinutes } from '@/common/rebuildchat/executionTimeout';

describe('executionTimeout', () => {
  test('parses a positive integer timeout in minutes', () => {
    expect(parseExecutionTimeoutMinutes('10')).toEqual({
      value: 10,
      error: null,
    });
    expect(DEFAULT_EXECUTION_TIMEOUT_MINUTES_INPUT).toBe('10');
  });

  test('rejects empty or invalid timeout values', () => {
    expect(parseExecutionTimeoutMinutes('')).toEqual({
      value: null,
      error: 'empty',
    });
    expect(parseExecutionTimeoutMinutes('abc')).toEqual({
      value: null,
      error: 'invalid',
    });
    expect(parseExecutionTimeoutMinutes('0')).toEqual({
      value: null,
      error: 'non_positive',
    });
    expect(getExecutionTimeoutValidationMessage('empty')).toBe('单次执行超时必须填写正整数分钟。');
  });

  test('converts minutes to milliseconds', () => {
    expect(getExecutionTimeoutMs(10)).toBe(600000);
  });
});
