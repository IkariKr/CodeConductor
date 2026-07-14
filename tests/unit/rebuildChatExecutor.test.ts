import { describe, expect, test } from '@jest/globals';
import { executeRebuildChatRun, type RebuildChatControl, type RebuildChatExecuteTurnResult } from '@/common/rebuildchat/rebuildChatExecutor';

const createControl = (): {
  control: RebuildChatControl;
  requestAbort: () => void;
  requestPause: () => void;
} => {
  let pauseRequested = false;
  let abortRequested = false;

  return {
    control: {
      isPauseRequested: () => pauseRequested,
      consumePauseRequest: () => {
        if (!pauseRequested) return false;
        pauseRequested = false;
        return true;
      },
      isAbortRequested: () => abortRequested,
    },
    requestAbort: () => {
      abortRequested = true;
    },
    requestPause: () => {
      pauseRequested = true;
    },
  };
};

const createTurnResult = (output: string, overrides: Partial<RebuildChatExecuteTurnResult> = {}): RebuildChatExecuteTurnResult => {
  return {
    output,
    exitCode: 0,
    conversationId: 'conv-1',
    fileChanges: {
      created: [],
      updated: ['file.md'],
      deleted: [],
    },
    retryDirective: null,
    ...overrides,
  };
};

describe('rebuildChatExecutor', () => {
  test('completes all turns and returns all_sent', async () => {
    const { control } = createControl();
    const prompts: string[] = [];

    const result = await executeRebuildChatRun({
      queue: [
        { role: 'user', text: 'first' },
        { role: 'user', text: 'second' },
      ],
      startIndex: 0,
      initialConversationId: null,
      includeHistoryContext: false,
      maxRounds: 2,
      stopOnNoChanges: false,
      control,
      executeTurn: async ({ prompt }) => {
        prompts.push(prompt);
        return createTurnResult('DONE');
      },
    });

    expect(result).toEqual({
      conversationId: 'conv-1',
      endReason: 'all_sent',
      nextTurnIndex: 2,
      retryDirective: null,
      status: 'completed',
    });
    expect(prompts).toHaveLength(2);
  });

  test('pauses after current turn when pause is requested', async () => {
    const { control, requestPause } = createControl();

    const result = await executeRebuildChatRun({
      queue: [
        { role: 'user', text: 'first' },
        { role: 'user', text: 'second' },
      ],
      startIndex: 0,
      initialConversationId: null,
      includeHistoryContext: false,
      maxRounds: 2,
      stopOnNoChanges: false,
      control,
      executeTurn: async ({ turnNumber }) => {
        if (turnNumber === 1) {
          requestPause();
        }
        return createTurnResult('DONE');
      },
    });

    expect(result).toEqual({
      conversationId: 'conv-1',
      endReason: null,
      nextTurnIndex: 1,
      retryDirective: null,
      status: 'paused',
    });
  });

  test('marks current turn as aborted when abort is requested during execution', async () => {
    const { control, requestAbort } = createControl();
    const records: Array<{ status: string }> = [];

    const result = await executeRebuildChatRun({
      queue: [{ role: 'user', text: 'first' }],
      startIndex: 0,
      initialConversationId: null,
      includeHistoryContext: false,
      maxRounds: 1,
      stopOnNoChanges: false,
      control,
      executeTurn: async () => {
        requestAbort();
        return createTurnResult('ABORTING', { exitCode: null });
      },
      onTurnRecord: (record) => {
        records.push({ status: record.status });
      },
    });

    expect(result).toEqual({
      conversationId: 'conv-1',
      endReason: 'aborted',
      nextTurnIndex: 1,
      retryDirective: null,
      status: 'completed',
    });
    expect(records).toEqual([{ status: 'aborted' }]);
  });

  test('stops on no_output when file changes are empty', async () => {
    const { control } = createControl();

    const result = await executeRebuildChatRun({
      queue: [{ role: 'user', text: 'first' }],
      startIndex: 0,
      initialConversationId: null,
      includeHistoryContext: false,
      maxRounds: 1,
      stopOnNoChanges: true,
      control,
      executeTurn: async () =>
        createTurnResult('NO_CHANGE', {
          fileChanges: {
            created: [],
            updated: [],
            deleted: [],
          },
        }),
    });

    expect(result).toEqual({
      conversationId: 'conv-1',
      endReason: 'no_output',
      nextTurnIndex: 1,
      retryDirective: null,
      status: 'completed',
    });
  });

  test('waits and retries current turn when quota directive is returned', async () => {
    const { control } = createControl();
    const records: Array<{ status: string }> = [];

    const result = await executeRebuildChatRun({
      queue: [{ role: 'user', text: 'first' }],
      startIndex: 0,
      initialConversationId: 'conv-1',
      includeHistoryContext: false,
      maxRounds: 1,
      stopOnNoChanges: false,
      control,
      executeTurn: async () =>
        createTurnResult('quota', {
          exitCode: 1,
          retryDirective: {
            reason: 'quota',
            retryAt: 1000,
            retryDelayMs: 1000,
            matchedText: 'Individual quota reached',
            source: 'output',
          },
        }),
      onTurnRecord: (record) => {
        records.push({ status: record.status });
      },
    });

    expect(result).toEqual({
      conversationId: 'conv-1',
      endReason: null,
      nextTurnIndex: 0,
      retryDirective: {
        reason: 'quota',
        retryAt: 1000,
        retryDelayMs: 1000,
        matchedText: 'Individual quota reached',
        source: 'output',
      },
      status: 'waiting_retry',
    });
    expect(records).toEqual([]);
  });
});
