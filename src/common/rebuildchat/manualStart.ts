export type ResolveRequestedStartIndexError = 'empty' | 'invalid' | 'out_of_range';

export interface ResolveRequestedStartIndexParams {
  fallbackIndex: number;
  queueLength: number;
  startTurnInput: string;
}

export type ResolveRequestedStartIndexResult =
  | {
      ok: false;
      error: ResolveRequestedStartIndexError;
    }
  | {
      fallbackIndex: number;
      isManualStartOverride: boolean;
      ok: true;
      requestedStartIndex: number;
      requestedTurnNumber: number;
    };

const clampIndex = (index: number, queueLength: number): number => {
  if (queueLength <= 0) {
    return 0;
  }

  return Math.min(Math.max(index, 0), queueLength - 1);
};

export const getStartTurnInputValue = (index: number, queueLength: number): string => {
  if (queueLength <= 0) {
    return '1';
  }

  return String(clampIndex(index, queueLength) + 1);
};

export const isManualStartOverride = (requestedStartIndex: number, fallbackIndex: number): boolean => {
  return requestedStartIndex !== fallbackIndex;
};

export const resolveRequestedStartIndex = (params: ResolveRequestedStartIndexParams): ResolveRequestedStartIndexResult => {
  const rawValue = params.startTurnInput.trim();
  if (!rawValue) {
    return {
      ok: false,
      error: 'empty',
    };
  }

  if (!/^\d+$/.test(rawValue)) {
    return {
      ok: false,
      error: 'invalid',
    };
  }

  const requestedTurnNumber = Number(rawValue);
  if (!Number.isFinite(requestedTurnNumber) || requestedTurnNumber < 1 || requestedTurnNumber > params.queueLength) {
    return {
      ok: false,
      error: 'out_of_range',
    };
  }

  const fallbackIndex = clampIndex(params.fallbackIndex, params.queueLength);
  const requestedStartIndex = requestedTurnNumber - 1;

  return {
    ok: true,
    fallbackIndex,
    requestedStartIndex,
    requestedTurnNumber,
    isManualStartOverride: isManualStartOverride(requestedStartIndex, fallbackIndex),
  };
};

export interface ResolveManualStartConversationIdParams {
  currentConversationId: string | null;
  fallbackIndex: number;
  requestedStartIndex: number;
  reuseConversationOnManualStart: boolean;
}

export const resolveManualStartConversationId = (params: ResolveManualStartConversationIdParams): string | null => {
  if (!isManualStartOverride(params.requestedStartIndex, params.fallbackIndex)) {
    return params.currentConversationId;
  }

  return params.reuseConversationOnManualStart ? params.currentConversationId : null;
};
