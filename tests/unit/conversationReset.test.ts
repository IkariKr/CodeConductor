import { describe, expect, test } from '@jest/globals';
import { getConversationResetValidationMessage, getDefaultConversationRoundCount, getNextConversationRoundCount, parseConversationResetEveryNRounds, shouldResetConversationBeforeTurn } from '@/common/rebuildchat/conversationReset';

describe('conversationReset', () => {
  test('parses empty and positive values', () => {
    expect(parseConversationResetEveryNRounds('')).toEqual({
      value: null,
      error: null,
    });
    expect(parseConversationResetEveryNRounds('12')).toEqual({
      value: 12,
      error: null,
    });
  });

  test('rejects invalid values', () => {
    expect(parseConversationResetEveryNRounds('abc')).toEqual({
      value: null,
      error: 'invalid',
    });
    expect(parseConversationResetEveryNRounds('0')).toEqual({
      value: null,
      error: 'non_positive',
    });
    expect(getConversationResetValidationMessage('invalid')).toBe('每 N 轮自动断开会话必须填写正整数。');
  });

  test('determines when a conversation should reset before a turn', () => {
    expect(
      shouldResetConversationBeforeTurn({
        conversationId: 'conv-1',
        currentConversationRoundCount: 3,
        resetEveryNRounds: 3,
      })
    ).toBe(true);
    expect(
      shouldResetConversationBeforeTurn({
        conversationId: 'conv-1',
        currentConversationRoundCount: 2,
        resetEveryNRounds: 3,
      })
    ).toBe(false);
  });

  test('computes next conversation round count', () => {
    expect(
      getNextConversationRoundCount({
        currentConversationId: null,
        currentConversationRoundCount: 0,
        resolvedConversationId: 'conv-1',
        startedNewConversation: true,
      })
    ).toBe(1);

    expect(
      getNextConversationRoundCount({
        currentConversationId: 'conv-1',
        currentConversationRoundCount: 2,
        resolvedConversationId: 'conv-1',
        startedNewConversation: false,
      })
    ).toBe(3);
  });

  test('derives a legacy default conversation round count', () => {
    expect(getDefaultConversationRoundCount('conv-1', 4)).toBe(4);
    expect(getDefaultConversationRoundCount(null, 4)).toBe(0);
  });
});
