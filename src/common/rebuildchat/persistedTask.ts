import { getDefaultConversationRoundCount } from './conversationReset';
import type { EditablePromptQueueItem } from './editablePromptQueue';
import { DEFAULT_EXECUTION_ERROR_RETRY_COUNT_INPUT } from './executionErrorRetry';
import { DEFAULT_EXECUTION_TIMEOUT_MINUTES_INPUT } from './executionTimeout';
import { getStartTurnInputValue } from './manualStart';
import type { QuotaRetryDirectiveSource } from './quotaRetryParser';
import type { RunEndReason, RunLogKind, RunStatus, RebuildChatTurnRecord } from './rebuildChatExecutor';

export type RebuildChatPersistedTaskStatus = 'idle' | 'running' | 'paused' | 'stopping' | 'waiting_retry' | 'completed' | 'failed' | 'aborted';
export type RebuildChatActiveTurnState = 'idle' | 'running' | 'completed_not_advanced';
export type RebuildChatStartPromptTrigger = 'task_start' | 'conversation_reset';
export type RebuildChatRetryPhase = 'start_prompt' | 'turn';

export interface RebuildChatPersistedRetryState {
  reason: 'quota';
  phase: RebuildChatRetryPhase;
  retryAt: number | null;
  retryDelayMs: number;
  retryAttemptCount: number;
  resumeTurnIndex: number;
  lastMatchedMessage: string;
  source: QuotaRetryDirectiveSource;
}

export interface RebuildChatPersistedLogEntry {
  id: string;
  kind: RunLogKind;
  text: string;
  timestamp: string;
}

export interface RebuildChatPersistedTurnRecord extends RebuildChatTurnRecord {
  id: string;
}

export interface RebuildChatPersistedStartPromptRecord {
  id: string;
  trigger: RebuildChatStartPromptTrigger;
  targetTurnIndex: number;
  prompt: string;
  output: string;
  status: 'completed' | 'failed' | 'aborted';
  conversationId: string | null;
  timestamp: string;
}

export interface RebuildChatPersistedTaskSource {
  filePath: string;
  rawContent: string;
  excludeThought: boolean;
  selectedRoles: string[];
}

export interface RebuildChatPersistedTaskProgress {
  conversationId: string | null;
  currentConversationRoundCount: number;
  currentTurnIndex: number;
  effectiveMaxRounds: number;
  hasSentStartPromptInCurrentConversation: boolean;
  pendingStartPromptTrigger: RebuildChatStartPromptTrigger | null;
  runEndReason: RunEndReason;
  runLogs: RebuildChatPersistedLogEntry[];
  startPromptRecords: RebuildChatPersistedStartPromptRecord[];
  turnRecords: RebuildChatPersistedTurnRecord[];
  activeTurnState: RebuildChatActiveTurnState;
  retryState?: RebuildChatPersistedRetryState | null;
}

export interface RebuildChatPersistedTask {
  taskId: string;
  createdAt: number;
  updatedAt: number;
  status: RebuildChatPersistedTaskStatus;
  source: RebuildChatPersistedTaskSource;
  queueSnapshot: EditablePromptQueueItem[];
  workDir: string;
  watchDir: string;
  watchExtensionsInput: string;
  includeHistoryContext: boolean;
  maxRoundsInput: string;
  executionErrorRetryCountInput: string;
  executionTimeoutMinutesInput: string;
  conversationResetEveryNRoundsInput: string;
  startPromptInput: string;
  startTurnInput: string;
  stopOnNoChanges: boolean;
  skipPermissions: boolean;
  reuseConversationOnManualStart: boolean;
  progress: RebuildChatPersistedTaskProgress;
}

const isStringArray = (value: unknown): value is string[] => {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
};

export const getPersistedTaskStatus = (runStatus: RunStatus, runEndReason: RunEndReason): RebuildChatPersistedTaskStatus => {
  if (runEndReason === 'aborted') {
    return 'aborted';
  }

  switch (runStatus) {
    case 'running':
    case 'paused':
    case 'stopping':
    case 'waiting_retry':
    case 'completed':
    case 'failed':
      return runStatus;
    default:
      return 'idle';
  }
};

export const getRebuildChatTaskResumeIndex = (task: RebuildChatPersistedTask): number => {
  const queueLength = task.queueSnapshot.length;
  const currentTurnIndex = Math.max(0, task.progress.currentTurnIndex);

  if (task.progress.activeTurnState === 'completed_not_advanced') {
    return Math.min(currentTurnIndex + 1, queueLength);
  }

  return Math.min(currentTurnIndex, queueLength);
};

export const canResumeRebuildChatTask = (task: RebuildChatPersistedTask): boolean => {
  if (!task.queueSnapshot.length) {
    return false;
  }

  if (!['paused', 'running', 'stopping', 'waiting_retry', 'failed'].includes(task.status)) {
    return false;
  }

  return getRebuildChatTaskResumeIndex(task) < task.queueSnapshot.length;
};

export const sortRebuildChatTasks = (tasks: RebuildChatPersistedTask[]): RebuildChatPersistedTask[] => {
  return [...tasks].sort((left, right) => right.updatedAt - left.updatedAt);
};

export const normalizeRebuildChatTasks = (value: unknown): RebuildChatPersistedTask[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return sortRebuildChatTasks(
    value.flatMap((item): RebuildChatPersistedTask[] => {
      if (!item || typeof item !== 'object') return [];

      const candidate = item as Partial<RebuildChatPersistedTask>;
      const retryState = candidate.progress?.retryState;
      const hasValidRetryState = typeof retryState === 'undefined' || retryState === null || (typeof retryState === 'object' && retryState.reason === 'quota' && (retryState.phase === 'start_prompt' || retryState.phase === 'turn' || typeof retryState.phase === 'undefined') && (typeof retryState.retryAt === 'number' || retryState.retryAt === null) && typeof retryState.retryDelayMs === 'number' && typeof retryState.retryAttemptCount === 'number' && typeof retryState.resumeTurnIndex === 'number' && typeof retryState.lastMatchedMessage === 'string' && (retryState.source === 'output' || retryState.source === 'rawLog'));
      const isValid =
        typeof candidate.taskId === 'string' &&
        typeof candidate.createdAt === 'number' &&
        typeof candidate.updatedAt === 'number' &&
        typeof candidate.status === 'string' &&
        Boolean(candidate.source) &&
        typeof candidate.source?.filePath === 'string' &&
        typeof candidate.source?.rawContent === 'string' &&
        typeof candidate.source?.excludeThought === 'boolean' &&
        isStringArray(candidate.source?.selectedRoles) &&
        Array.isArray(candidate.queueSnapshot) &&
        typeof candidate.workDir === 'string' &&
        typeof candidate.watchDir === 'string' &&
        typeof candidate.watchExtensionsInput === 'string' &&
        typeof candidate.includeHistoryContext === 'boolean' &&
        typeof candidate.maxRoundsInput === 'string' &&
        (typeof candidate.executionErrorRetryCountInput === 'string' || typeof candidate.executionErrorRetryCountInput === 'undefined') &&
        (typeof candidate.executionTimeoutMinutesInput === 'string' || typeof candidate.executionTimeoutMinutesInput === 'undefined') &&
        (typeof candidate.conversationResetEveryNRoundsInput === 'string' || typeof candidate.conversationResetEveryNRoundsInput === 'undefined') &&
        (typeof candidate.startPromptInput === 'string' || typeof candidate.startPromptInput === 'undefined') &&
        typeof candidate.stopOnNoChanges === 'boolean' &&
        typeof candidate.skipPermissions === 'boolean' &&
        Boolean(candidate.progress) &&
        (typeof candidate.progress?.currentConversationRoundCount === 'number' || typeof candidate.progress?.currentConversationRoundCount === 'undefined') &&
        typeof candidate.progress?.currentTurnIndex === 'number' &&
        typeof candidate.progress?.effectiveMaxRounds === 'number' &&
        (typeof candidate.progress?.hasSentStartPromptInCurrentConversation === 'boolean' || typeof candidate.progress?.hasSentStartPromptInCurrentConversation === 'undefined') &&
        (candidate.progress?.pendingStartPromptTrigger === 'task_start' || candidate.progress?.pendingStartPromptTrigger === 'conversation_reset' || typeof candidate.progress?.pendingStartPromptTrigger === 'undefined' || candidate.progress?.pendingStartPromptTrigger === null) &&
        Array.isArray(candidate.progress?.runLogs) &&
        (Array.isArray(candidate.progress?.startPromptRecords) || typeof candidate.progress?.startPromptRecords === 'undefined') &&
        Array.isArray(candidate.progress?.turnRecords) &&
        typeof candidate.progress?.activeTurnState === 'string' &&
        hasValidRetryState;

      if (!isValid) {
        return [];
      }

      const queueLength = candidate.queueSnapshot?.length ?? 0;
      const currentTurnIndex = candidate.progress?.currentTurnIndex ?? 0;

      return [
        {
          ...(candidate as RebuildChatPersistedTask),
          executionErrorRetryCountInput: typeof candidate.executionErrorRetryCountInput === 'string' ? candidate.executionErrorRetryCountInput : DEFAULT_EXECUTION_ERROR_RETRY_COUNT_INPUT,
          executionTimeoutMinutesInput: typeof candidate.executionTimeoutMinutesInput === 'string' ? candidate.executionTimeoutMinutesInput : DEFAULT_EXECUTION_TIMEOUT_MINUTES_INPUT,
          conversationResetEveryNRoundsInput: typeof candidate.conversationResetEveryNRoundsInput === 'string' ? candidate.conversationResetEveryNRoundsInput : '',
          startPromptInput: typeof candidate.startPromptInput === 'string' ? candidate.startPromptInput : '',
          startTurnInput: typeof candidate.startTurnInput === 'string' ? candidate.startTurnInput : getStartTurnInputValue(currentTurnIndex, queueLength),
          reuseConversationOnManualStart: typeof candidate.reuseConversationOnManualStart === 'boolean' ? candidate.reuseConversationOnManualStart : false,
          progress: {
            ...(candidate.progress as RebuildChatPersistedTaskProgress),
            currentConversationRoundCount: typeof candidate.progress?.currentConversationRoundCount === 'number' ? candidate.progress.currentConversationRoundCount : getDefaultConversationRoundCount(candidate.progress?.conversationId ?? null, currentTurnIndex),
            hasSentStartPromptInCurrentConversation: typeof candidate.progress?.hasSentStartPromptInCurrentConversation === 'boolean' ? candidate.progress.hasSentStartPromptInCurrentConversation : true,
            pendingStartPromptTrigger: candidate.progress?.pendingStartPromptTrigger === 'task_start' || candidate.progress?.pendingStartPromptTrigger === 'conversation_reset' ? candidate.progress.pendingStartPromptTrigger : null,
            startPromptRecords: Array.isArray(candidate.progress?.startPromptRecords) ? candidate.progress.startPromptRecords : [],
            retryState:
              candidate.progress?.retryState && typeof candidate.progress.retryState === 'object'
                ? {
                    ...candidate.progress.retryState,
                    phase: candidate.progress.retryState.phase === 'start_prompt' ? 'start_prompt' : 'turn',
                  }
                : (candidate.progress?.retryState ?? null),
          },
        },
      ];
    })
  );
};
