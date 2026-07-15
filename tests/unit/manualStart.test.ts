import { describe, expect, test } from '@jest/globals';
import { getStartTurnInputValue, isManualStartOverride, resolveManualStartConversationId, resolveRequestedStartIndex } from '@/common/rebuildchat/manualStart';

describe('manualStart', () => {
  test('resolves requested start index from 1-based input', () => {
    expect(resolveRequestedStartIndex({ queueLength: 50, startTurnInput: '1', fallbackIndex: 0 })).toEqual({
      ok: true,
      fallbackIndex: 0,
      requestedStartIndex: 0,
      requestedTurnNumber: 1,
      isManualStartOverride: false,
    });

    expect(resolveRequestedStartIndex({ queueLength: 50, startTurnInput: '46', fallbackIndex: 0 })).toEqual({
      ok: true,
      fallbackIndex: 0,
      requestedStartIndex: 45,
      requestedTurnNumber: 46,
      isManualStartOverride: true,
    });
  });

  test('rejects empty invalid and out of range inputs', () => {
    expect(resolveRequestedStartIndex({ queueLength: 5, startTurnInput: '', fallbackIndex: 0 })).toEqual({
      ok: false,
      error: 'empty',
    });
    expect(resolveRequestedStartIndex({ queueLength: 5, startTurnInput: 'abc', fallbackIndex: 0 })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(resolveRequestedStartIndex({ queueLength: 5, startTurnInput: '6', fallbackIndex: 0 })).toEqual({
      ok: false,
      error: 'out_of_range',
    });
  });

  test('determines whether a manual override is active', () => {
    expect(isManualStartOverride(1, 1)).toBe(false);
    expect(isManualStartOverride(45, 0)).toBe(true);
  });

  test('resolves conversation reuse for manual starts', () => {
    expect(
      resolveManualStartConversationId({
        currentConversationId: 'conv-1',
        fallbackIndex: 1,
        requestedStartIndex: 1,
        reuseConversationOnManualStart: false,
      })
    ).toBe('conv-1');

    expect(
      resolveManualStartConversationId({
        currentConversationId: 'conv-1',
        fallbackIndex: 1,
        requestedStartIndex: 2,
        reuseConversationOnManualStart: false,
      })
    ).toBeNull();

    expect(
      resolveManualStartConversationId({
        currentConversationId: 'conv-1',
        fallbackIndex: 1,
        requestedStartIndex: 2,
        reuseConversationOnManualStart: true,
      })
    ).toBe('conv-1');
  });

  test('formats start turn input from a zero-based index', () => {
    expect(getStartTurnInputValue(0, 50)).toBe('1');
    expect(getStartTurnInputValue(45, 50)).toBe('46');
    expect(getStartTurnInputValue(99, 50)).toBe('50');
  });
});
