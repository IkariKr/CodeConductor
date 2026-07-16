export interface ParseExecutionTimeoutMinutesResult {
  error: 'empty' | 'invalid' | 'non_positive' | null;
  value: number | null;
}

export const DEFAULT_EXECUTION_TIMEOUT_MINUTES_INPUT = '10';

export const parseExecutionTimeoutMinutes = (input: string): ParseExecutionTimeoutMinutesResult => {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      value: null,
      error: 'empty',
    };
  }

  if (!/^\d+$/.test(trimmed)) {
    return {
      value: null,
      error: 'invalid',
    };
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      value: null,
      error: 'non_positive',
    };
  }

  return {
    value: parsed,
    error: null,
  };
};

export const getExecutionTimeoutValidationMessage = (error: 'empty' | 'invalid' | 'non_positive'): string => {
  switch (error) {
    case 'empty':
      return '单次执行超时必须填写正整数分钟。';
    case 'invalid':
      return '单次执行超时必须填写正整数分钟。';
    default:
      return '单次执行超时必须大于 0 分钟。';
  }
};

export const getExecutionTimeoutMs = (minutes: number): number => {
  return Math.max(minutes, 0) * 60 * 1000;
};
