export interface ParseExecutionErrorRetryCountResult {
  error: 'empty' | 'invalid' | 'negative' | null;
  value: number | null;
}

export const DEFAULT_EXECUTION_ERROR_RETRY_COUNT_INPUT = '1';

export const parseExecutionErrorRetryCount = (input: string): ParseExecutionErrorRetryCountResult => {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      value: null,
      error: 'empty',
    };
  }

  if (!/^-?\d+$/.test(trimmed)) {
    return {
      value: null,
      error: 'invalid',
    };
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return {
      value: null,
      error: 'invalid',
    };
  }

  if (parsed < 0) {
    return {
      value: null,
      error: 'negative',
    };
  }

  return {
    value: parsed,
    error: null,
  };
};

export const getExecutionErrorRetryValidationMessage = (error: 'empty' | 'invalid' | 'negative'): string => {
  switch (error) {
    case 'negative':
      return '普通错误自动重试次数不能小于 0。';
    case 'empty':
    case 'invalid':
    default:
      return '普通错误自动重试次数必须填写 0 或正整数。';
  }
};
