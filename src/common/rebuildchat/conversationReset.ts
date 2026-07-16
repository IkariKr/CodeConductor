export interface ParseConversationResetEveryNRoundsResult {
  error: 'invalid' | 'non_positive' | null;
  value: number | null;
}

export const parseConversationResetEveryNRounds = (input: string): ParseConversationResetEveryNRoundsResult => {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      value: null,
      error: null,
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

export const getConversationResetValidationMessage = (error: 'invalid' | 'non_positive'): string => {
  if (error === 'invalid') {
    return '每 N 轮自动断开会话必须填写正整数。';
  }

  return '每 N 轮自动断开会话必须大于 0。';
};

export interface ShouldResetConversationParams {
  conversationId: string | null;
  currentConversationRoundCount: number;
  resetEveryNRounds: number | null;
}

export const shouldResetConversationBeforeTurn = (params: ShouldResetConversationParams): boolean => {
  if (!params.conversationId || params.resetEveryNRounds === null) {
    return false;
  }

  return params.currentConversationRoundCount >= params.resetEveryNRounds;
};

export interface GetNextConversationRoundCountParams {
  currentConversationId: string | null;
  currentConversationRoundCount: number;
  resolvedConversationId: string | null;
  startedNewConversation: boolean;
}

export const getNextConversationRoundCount = (params: GetNextConversationRoundCountParams): number => {
  if (!params.resolvedConversationId) {
    return 0;
  }

  if (params.startedNewConversation || !params.currentConversationId) {
    return 1;
  }

  return params.currentConversationRoundCount + 1;
};

export const getDefaultConversationRoundCount = (conversationId: string | null, currentTurnIndex: number): number => {
  if (!conversationId) {
    return 0;
  }

  return Math.max(currentTurnIndex, 0);
};
