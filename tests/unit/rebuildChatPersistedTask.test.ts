import { describe, expect, test } from '@jest/globals';
import { canResumeRebuildChatTask, getPersistedTaskStatus, getRebuildChatTaskResumeIndex, normalizeRebuildChatTasks, sortRebuildChatTasks, type RebuildChatPersistedTask } from '@/common/rebuildchat/persistedTask';

const createTask = (overrides: Partial<RebuildChatPersistedTask> = {}): RebuildChatPersistedTask => ({
  taskId: 'task-1',
  createdAt: 1,
  updatedAt: 10,
  status: 'paused',
  source: {
    filePath: 'D:/fixtures/sample.json',
    rawContent: '{"chunkedPrompt":{"chunks":[]}}',
    excludeThought: true,
    selectedRoles: ['user'],
  },
  queueSnapshot: [
    {
      id: 'queue-1',
      sourceChunkId: 'chunk-1',
      role: 'user',
      text: 'first',
      tokenCount: 10,
      sourceIndex: 0,
      isThought: false,
      isCustom: false,
      edited: false,
    },
    {
      id: 'queue-2',
      sourceChunkId: 'chunk-2',
      role: 'user',
      text: 'second',
      tokenCount: 10,
      sourceIndex: 1,
      isThought: false,
      isCustom: false,
      edited: true,
    },
  ],
  workDir: 'D:/fixtures/workdir',
  watchDir: 'D:/fixtures/workdir',
  watchExtensionsInput: '.md',
  includeHistoryContext: false,
  maxRoundsInput: '2',
  executionErrorRetryCountInput: '1',
  executionTimeoutMinutesInput: '10',
  conversationResetEveryNRoundsInput: '3',
  startPromptInput: 'warm up',
  startTurnInput: '2',
  stopOnNoChanges: true,
  skipPermissions: false,
  reuseConversationOnManualStart: false,
  progress: {
    conversationId: 'conv-1',
    currentConversationRoundCount: 1,
    currentTurnIndex: 1,
    effectiveMaxRounds: 2,
    hasSentStartPromptInCurrentConversation: true,
    pendingStartPromptTrigger: null,
    runEndReason: null,
    runLogs: [],
    startPromptRecords: [],
    turnRecords: [],
    activeTurnState: 'idle',
  },
  ...overrides,
});

describe('rebuildChatPersistedTask', () => {
  test('maps aborted completed state correctly', () => {
    expect(getPersistedTaskStatus('completed', 'aborted')).toBe('aborted');
    expect(getPersistedTaskStatus('failed', 'failed')).toBe('failed');
    expect(getPersistedTaskStatus('waiting_retry', null)).toBe('waiting_retry');
    expect(getPersistedTaskStatus('idle', null)).toBe('idle');
  });

  test('resolves resume index for interrupted and completed-not-advanced turns', () => {
    expect(
      getRebuildChatTaskResumeIndex(
        createTask({
          status: 'running',
          progress: {
            ...createTask().progress,
            currentTurnIndex: 0,
            activeTurnState: 'running',
          },
        })
      )
    ).toBe(0);

    expect(
      getRebuildChatTaskResumeIndex(
        createTask({
          progress: {
            ...createTask().progress,
            currentTurnIndex: 0,
            activeTurnState: 'completed_not_advanced',
          },
        })
      )
    ).toBe(1);
  });

  test('allows resume only for resumable states with remaining queue items', () => {
    expect(canResumeRebuildChatTask(createTask())).toBe(true);
    expect(canResumeRebuildChatTask(createTask({ status: 'waiting_retry' }))).toBe(true);
    expect(canResumeRebuildChatTask(createTask({ status: 'completed' }))).toBe(false);
    expect(
      canResumeRebuildChatTask(
        createTask({
          status: 'failed',
          progress: {
            ...createTask().progress,
            currentTurnIndex: 2,
          },
        })
      )
    ).toBe(false);
  });

  test('sorts tasks by updatedAt desc and drops invalid entries', () => {
    const tasks = sortRebuildChatTasks([createTask({ taskId: 'older', updatedAt: 1 }), createTask({ taskId: 'newer', updatedAt: 100 })]);
    expect(tasks.map((task) => task.taskId)).toEqual(['newer', 'older']);

    const normalized = normalizeRebuildChatTasks([createTask({ taskId: 'valid' }), { bad: true }]);
    expect(normalized.map((task) => task.taskId)).toEqual(['valid']);
  });

  test('fills manual start defaults for legacy task records', () => {
    const legacyTask = createTask({ taskId: 'legacy' }) as unknown as Record<string, unknown>;
    delete legacyTask.executionErrorRetryCountInput;
    delete legacyTask.executionTimeoutMinutesInput;
    delete legacyTask.conversationResetEveryNRoundsInput;
    delete legacyTask.startPromptInput;
    delete legacyTask.startTurnInput;
    delete legacyTask.reuseConversationOnManualStart;

    const normalized = normalizeRebuildChatTasks([legacyTask]);
    expect(normalized[0]?.executionErrorRetryCountInput).toBe('1');
    expect(normalized[0]?.executionTimeoutMinutesInput).toBe('10');
    expect(normalized[0]?.conversationResetEveryNRoundsInput).toBe('');
    expect(normalized[0]?.startPromptInput).toBe('');
    expect(normalized[0]?.startTurnInput).toBe('2');
    expect(normalized[0]?.reuseConversationOnManualStart).toBe(false);
  });

  test('fills legacy conversation round count default from progress', () => {
    const legacyTask = createTask({ taskId: 'legacy-conv' }) as unknown as Record<string, unknown>;
    if (legacyTask.progress && typeof legacyTask.progress === 'object') {
      delete (legacyTask.progress as Record<string, unknown>).currentConversationRoundCount;
    }

    const normalized = normalizeRebuildChatTasks([legacyTask]);
    expect(normalized[0]?.progress.currentConversationRoundCount).toBe(1);
  });

  test('keeps valid retry state during normalization', () => {
    const normalized = normalizeRebuildChatTasks([
      createTask({
        taskId: 'waiting',
        status: 'waiting_retry',
        progress: {
          ...createTask().progress,
          retryState: {
            reason: 'quota',
            phase: 'turn',
            retryAt: 123,
            retryDelayMs: 5000,
            retryAttemptCount: 2,
            resumeTurnIndex: 1,
            lastMatchedMessage: 'quota reached',
            source: 'output',
          },
        },
      }),
    ]);

    expect(normalized[0]?.progress.retryState?.retryAttemptCount).toBe(2);
  });

  test('fills legacy start prompt state defaults during normalization', () => {
    const legacyTask = createTask({ taskId: 'legacy-start-prompt' }) as unknown as Record<string, unknown>;
    if (legacyTask.progress && typeof legacyTask.progress === 'object') {
      delete (legacyTask.progress as Record<string, unknown>).hasSentStartPromptInCurrentConversation;
      delete (legacyTask.progress as Record<string, unknown>).pendingStartPromptTrigger;
      delete (legacyTask.progress as Record<string, unknown>).startPromptRecords;
    }

    const normalized = normalizeRebuildChatTasks([legacyTask]);
    expect(normalized[0]?.progress.hasSentStartPromptInCurrentConversation).toBe(true);
    expect(normalized[0]?.progress.pendingStartPromptTrigger).toBeNull();
    expect(normalized[0]?.progress.startPromptRecords).toEqual([]);
  });
});
