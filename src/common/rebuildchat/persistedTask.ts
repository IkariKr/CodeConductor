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
export type RebuildChatTaskHistoryKind = 'runLogs' | 'startPromptRecords' | 'turnRecords';

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

export interface RebuildChatPersistedTaskSourceSnapshot extends RebuildChatPersistedTaskSource {
  queueSnapshot: EditablePromptQueueItem[];
}

export interface RebuildChatPersistedTaskHistoryCounts {
  runLogCount: number;
  startPromptRecordCount: number;
  turnRecordCount: number;
}

export interface RebuildChatTaskHistorySlice<TEntry> {
  hasMore: boolean;
  items: TEntry[];
  limit: number;
  offsetFromLatest: number;
  totalCount: number;
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
  skipTurnOnNoOutput: boolean;
  stopOnNoChanges?: boolean;
  skipPermissions: boolean;
  reuseConversationOnManualStart: boolean;
  progress: RebuildChatPersistedTaskProgress;
}

export interface RebuildChatPersistedTaskMeta {
  taskId: string;
  createdAt: number;
  updatedAt: number;
  status: RebuildChatPersistedTaskStatus;
  source: Pick<RebuildChatPersistedTaskSource, 'filePath'>;
  queueLength: number;
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
  skipTurnOnNoOutput: boolean;
  stopOnNoChanges?: boolean;
  skipPermissions: boolean;
  reuseConversationOnManualStart: boolean;
  progress: Omit<RebuildChatPersistedTaskProgress, 'runLogs' | 'startPromptRecords' | 'turnRecords'> & RebuildChatPersistedTaskHistoryCounts;
}

export interface RebuildChatPersistedTaskSummary {
  taskId: string;
  createdAt: number;
  updatedAt: number;
  status: RebuildChatPersistedTaskStatus;
  source: Pick<RebuildChatPersistedTaskSource, 'filePath'>;
  queueLength: number;
  workDir: string;
  progress: Pick<RebuildChatPersistedTaskMeta['progress'], 'conversationId' | 'currentTurnIndex' | 'effectiveMaxRounds' | 'activeTurnState' | 'retryState' | 'runLogCount' | 'startPromptRecordCount' | 'turnRecordCount'>;
}

export interface RebuildChatPersistedTaskPreview {
  meta: RebuildChatPersistedTaskMeta;
  task: RebuildChatPersistedTask;
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

const getQueueLength = (task: RebuildChatPersistedTask | RebuildChatPersistedTaskSummary): number => {
  return 'queueLength' in task ? task.queueLength : task.queueSnapshot.length;
};

export const toRebuildChatPersistedTaskSourceSnapshot = (task: RebuildChatPersistedTask): RebuildChatPersistedTaskSourceSnapshot => ({
  filePath: task.source.filePath,
  rawContent: task.source.rawContent,
  excludeThought: task.source.excludeThought,
  selectedRoles: [...task.source.selectedRoles],
  queueSnapshot: task.queueSnapshot.map((item) => ({ ...item })),
});

export const toRebuildChatPersistedTaskMeta = (task: RebuildChatPersistedTask): RebuildChatPersistedTaskMeta => ({
  taskId: task.taskId,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  status: task.status,
  source: {
    filePath: task.source.filePath,
  },
  queueLength: task.queueSnapshot.length,
  workDir: task.workDir,
  watchDir: task.watchDir,
  watchExtensionsInput: task.watchExtensionsInput,
  includeHistoryContext: task.includeHistoryContext,
  maxRoundsInput: task.maxRoundsInput,
  executionErrorRetryCountInput: task.executionErrorRetryCountInput,
  executionTimeoutMinutesInput: task.executionTimeoutMinutesInput,
  conversationResetEveryNRoundsInput: task.conversationResetEveryNRoundsInput,
  startPromptInput: task.startPromptInput,
  startTurnInput: task.startTurnInput,
  skipTurnOnNoOutput: task.skipTurnOnNoOutput,
  stopOnNoChanges: task.stopOnNoChanges,
  skipPermissions: task.skipPermissions,
  reuseConversationOnManualStart: task.reuseConversationOnManualStart,
  progress: {
    conversationId: task.progress.conversationId,
    currentConversationRoundCount: task.progress.currentConversationRoundCount,
    currentTurnIndex: task.progress.currentTurnIndex,
    effectiveMaxRounds: task.progress.effectiveMaxRounds,
    hasSentStartPromptInCurrentConversation: task.progress.hasSentStartPromptInCurrentConversation,
    pendingStartPromptTrigger: task.progress.pendingStartPromptTrigger,
    runEndReason: task.progress.runEndReason,
    activeTurnState: task.progress.activeTurnState,
    retryState: task.progress.retryState ?? null,
    runLogCount: task.progress.runLogs.length,
    startPromptRecordCount: task.progress.startPromptRecords.length,
    turnRecordCount: task.progress.turnRecords.length,
  },
});

export const toRebuildChatPersistedTaskSummaryFromMeta = (task: RebuildChatPersistedTaskMeta): RebuildChatPersistedTaskSummary => ({
  taskId: task.taskId,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  status: task.status,
  source: {
    filePath: task.source.filePath,
  },
  queueLength: task.queueLength,
  workDir: task.workDir,
  progress: {
    conversationId: task.progress.conversationId,
    currentTurnIndex: task.progress.currentTurnIndex,
    effectiveMaxRounds: task.progress.effectiveMaxRounds,
    activeTurnState: task.progress.activeTurnState,
    retryState: task.progress.retryState ?? null,
    runLogCount: task.progress.runLogCount,
    startPromptRecordCount: task.progress.startPromptRecordCount,
    turnRecordCount: task.progress.turnRecordCount,
  },
});

export const toRebuildChatPersistedTaskSummary = (task: RebuildChatPersistedTask): RebuildChatPersistedTaskSummary => {
  return toRebuildChatPersistedTaskSummaryFromMeta(toRebuildChatPersistedTaskMeta(task));
};

export const getRebuildChatTaskResumeIndex = (task: RebuildChatPersistedTask | RebuildChatPersistedTaskSummary): number => {
  const queueLength = getQueueLength(task);
  const currentTurnIndex = Math.max(0, task.progress.currentTurnIndex);

  if (task.progress.activeTurnState === 'completed_not_advanced') {
    return Math.min(currentTurnIndex + 1, queueLength);
  }

  return Math.min(currentTurnIndex, queueLength);
};

export const canResumeRebuildChatTask = (task: RebuildChatPersistedTask | RebuildChatPersistedTaskSummary): boolean => {
  if (!getQueueLength(task)) {
    return false;
  }

  if (!['paused', 'running', 'stopping', 'waiting_retry', 'failed'].includes(task.status)) {
    return false;
  }

  return getRebuildChatTaskResumeIndex(task) < getQueueLength(task);
};

export const sortRebuildChatTasks = (tasks: RebuildChatPersistedTask[]): RebuildChatPersistedTask[] => {
  return [...tasks].sort((left, right) => right.updatedAt - left.updatedAt);
};

export const sortRebuildChatTaskSummaries = (tasks: RebuildChatPersistedTaskSummary[]): RebuildChatPersistedTaskSummary[] => {
  return [...tasks].sort((left, right) => right.updatedAt - left.updatedAt);
};

export const sortRebuildChatTaskMetas = (tasks: RebuildChatPersistedTaskMeta[]): RebuildChatPersistedTaskMeta[] => {
  return [...tasks].sort((left, right) => right.updatedAt - left.updatedAt);
};

export const mergeRebuildChatTasks = (...taskGroups: RebuildChatPersistedTask[][]): RebuildChatPersistedTask[] => {
  const taskMap = new Map<string, RebuildChatPersistedTask>();

  for (const taskGroup of taskGroups) {
    for (const task of taskGroup) {
      const existing = taskMap.get(task.taskId);
      if (!existing || task.updatedAt >= existing.updatedAt) {
        taskMap.set(task.taskId, task);
      }
    }
  }

  return sortRebuildChatTasks([...taskMap.values()]);
};

export const hasRebuildChatTaskListChanged = <
  TTask extends {
    taskId: string;
    updatedAt: number;
  },
>(
  currentTasks: TTask[],
  nextTasks: TTask[]
): boolean => {
  if (currentTasks.length !== nextTasks.length) {
    return true;
  }

  return nextTasks.some((task, index) => currentTasks[index]?.taskId !== task.taskId || currentTasks[index]?.updatedAt !== task.updatedAt);
};

export const normalizeRebuildChatTaskSummaries = (value: unknown): RebuildChatPersistedTaskSummary[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return sortRebuildChatTaskSummaries(
    value.flatMap((item): RebuildChatPersistedTaskSummary[] => {
      if (!item || typeof item !== 'object') {
        return [];
      }

      const candidate = item as Partial<RebuildChatPersistedTaskSummary>;
      const retryState = candidate.progress?.retryState;
      const hasValidRetryState = typeof retryState === 'undefined' || retryState === null || (typeof retryState === 'object' && retryState.reason === 'quota' && (retryState.phase === 'start_prompt' || retryState.phase === 'turn' || typeof retryState.phase === 'undefined') && (typeof retryState.retryAt === 'number' || retryState.retryAt === null) && typeof retryState.retryDelayMs === 'number' && typeof retryState.retryAttemptCount === 'number' && typeof retryState.resumeTurnIndex === 'number' && typeof retryState.lastMatchedMessage === 'string' && (retryState.source === 'output' || retryState.source === 'rawLog'));

      const isValid =
        typeof candidate.taskId === 'string' &&
        typeof candidate.createdAt === 'number' &&
        typeof candidate.updatedAt === 'number' &&
        typeof candidate.status === 'string' &&
        Boolean(candidate.source) &&
        typeof candidate.source?.filePath === 'string' &&
        typeof candidate.queueLength === 'number' &&
        typeof candidate.workDir === 'string' &&
        Boolean(candidate.progress) &&
        (typeof candidate.progress?.conversationId === 'string' || candidate.progress?.conversationId === null) &&
        typeof candidate.progress?.currentTurnIndex === 'number' &&
        typeof candidate.progress?.effectiveMaxRounds === 'number' &&
        typeof candidate.progress?.activeTurnState === 'string' &&
        typeof candidate.progress?.runLogCount === 'number' &&
        typeof candidate.progress?.startPromptRecordCount === 'number' &&
        typeof candidate.progress?.turnRecordCount === 'number' &&
        hasValidRetryState;

      if (!isValid) {
        return [];
      }

      return [
        {
          ...(candidate as RebuildChatPersistedTaskSummary),
          progress: {
            ...(candidate.progress as RebuildChatPersistedTaskSummary['progress']),
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

export const normalizeRebuildChatTaskMeta = (value: unknown): RebuildChatPersistedTaskMeta | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<RebuildChatPersistedTaskMeta>;
  const retryState = candidate.progress?.retryState;
  const hasValidRetryState = typeof retryState === 'undefined' || retryState === null || (typeof retryState === 'object' && retryState.reason === 'quota' && (retryState.phase === 'start_prompt' || retryState.phase === 'turn' || typeof retryState.phase === 'undefined') && (typeof retryState.retryAt === 'number' || retryState.retryAt === null) && typeof retryState.retryDelayMs === 'number' && typeof retryState.retryAttemptCount === 'number' && typeof retryState.resumeTurnIndex === 'number' && typeof retryState.lastMatchedMessage === 'string' && (retryState.source === 'output' || retryState.source === 'rawLog'));

  const isValid =
    typeof candidate.taskId === 'string' &&
    typeof candidate.createdAt === 'number' &&
    typeof candidate.updatedAt === 'number' &&
    typeof candidate.status === 'string' &&
    Boolean(candidate.source) &&
    typeof candidate.source?.filePath === 'string' &&
    typeof candidate.queueLength === 'number' &&
    typeof candidate.workDir === 'string' &&
    typeof candidate.watchDir === 'string' &&
    typeof candidate.watchExtensionsInput === 'string' &&
    typeof candidate.includeHistoryContext === 'boolean' &&
    typeof candidate.maxRoundsInput === 'string' &&
    (typeof candidate.executionErrorRetryCountInput === 'string' || typeof candidate.executionErrorRetryCountInput === 'undefined') &&
    (typeof candidate.executionTimeoutMinutesInput === 'string' || typeof candidate.executionTimeoutMinutesInput === 'undefined') &&
    (typeof candidate.conversationResetEveryNRoundsInput === 'string' || typeof candidate.conversationResetEveryNRoundsInput === 'undefined') &&
    (typeof candidate.startPromptInput === 'string' || typeof candidate.startPromptInput === 'undefined') &&
    (typeof candidate.startTurnInput === 'string' || typeof candidate.startTurnInput === 'undefined') &&
    (typeof candidate.skipTurnOnNoOutput === 'boolean' || typeof candidate.skipTurnOnNoOutput === 'undefined') &&
    (typeof candidate.stopOnNoChanges === 'boolean' || typeof candidate.stopOnNoChanges === 'undefined') &&
    typeof candidate.skipPermissions === 'boolean' &&
    typeof candidate.reuseConversationOnManualStart === 'boolean' &&
    Boolean(candidate.progress) &&
    (typeof candidate.progress?.conversationId === 'string' || candidate.progress?.conversationId === null) &&
    (typeof candidate.progress?.currentConversationRoundCount === 'number' || typeof candidate.progress?.currentConversationRoundCount === 'undefined') &&
    typeof candidate.progress?.currentTurnIndex === 'number' &&
    typeof candidate.progress?.effectiveMaxRounds === 'number' &&
    (typeof candidate.progress?.hasSentStartPromptInCurrentConversation === 'boolean' || typeof candidate.progress?.hasSentStartPromptInCurrentConversation === 'undefined') &&
    (candidate.progress?.pendingStartPromptTrigger === 'task_start' || candidate.progress?.pendingStartPromptTrigger === 'conversation_reset' || typeof candidate.progress?.pendingStartPromptTrigger === 'undefined' || candidate.progress?.pendingStartPromptTrigger === null) &&
    typeof candidate.progress?.runLogCount === 'number' &&
    typeof candidate.progress?.startPromptRecordCount === 'number' &&
    typeof candidate.progress?.turnRecordCount === 'number' &&
    typeof candidate.progress?.activeTurnState === 'string' &&
    hasValidRetryState;

  if (!isValid) {
    return null;
  }

  const currentTurnIndex = candidate.progress?.currentTurnIndex ?? 0;

  return {
    ...(candidate as RebuildChatPersistedTaskMeta),
    executionErrorRetryCountInput: typeof candidate.executionErrorRetryCountInput === 'string' ? candidate.executionErrorRetryCountInput : DEFAULT_EXECUTION_ERROR_RETRY_COUNT_INPUT,
    executionTimeoutMinutesInput: typeof candidate.executionTimeoutMinutesInput === 'string' ? candidate.executionTimeoutMinutesInput : DEFAULT_EXECUTION_TIMEOUT_MINUTES_INPUT,
    conversationResetEveryNRoundsInput: typeof candidate.conversationResetEveryNRoundsInput === 'string' ? candidate.conversationResetEveryNRoundsInput : '',
    startPromptInput: typeof candidate.startPromptInput === 'string' ? candidate.startPromptInput : '',
    startTurnInput: typeof candidate.startTurnInput === 'string' ? candidate.startTurnInput : getStartTurnInputValue(currentTurnIndex, candidate.queueLength ?? 0),
    skipTurnOnNoOutput: typeof candidate.skipTurnOnNoOutput === 'boolean' ? candidate.skipTurnOnNoOutput : true,
    progress: {
      ...(candidate.progress as RebuildChatPersistedTaskMeta['progress']),
      currentConversationRoundCount: typeof candidate.progress?.currentConversationRoundCount === 'number' ? candidate.progress.currentConversationRoundCount : getDefaultConversationRoundCount(candidate.progress?.conversationId ?? null, currentTurnIndex),
      hasSentStartPromptInCurrentConversation: typeof candidate.progress?.hasSentStartPromptInCurrentConversation === 'boolean' ? candidate.progress.hasSentStartPromptInCurrentConversation : true,
      pendingStartPromptTrigger: candidate.progress?.pendingStartPromptTrigger === 'task_start' || candidate.progress?.pendingStartPromptTrigger === 'conversation_reset' ? candidate.progress.pendingStartPromptTrigger : null,
      retryState:
        candidate.progress?.retryState && typeof candidate.progress.retryState === 'object'
          ? {
              ...candidate.progress.retryState,
              phase: candidate.progress.retryState.phase === 'start_prompt' ? 'start_prompt' : 'turn',
            }
          : (candidate.progress?.retryState ?? null),
    },
  };
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
        (typeof candidate.skipTurnOnNoOutput === 'boolean' || typeof candidate.skipTurnOnNoOutput === 'undefined') &&
        (typeof candidate.stopOnNoChanges === 'boolean' || typeof candidate.stopOnNoChanges === 'undefined') &&
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
          skipTurnOnNoOutput: typeof candidate.skipTurnOnNoOutput === 'boolean' ? candidate.skipTurnOnNoOutput : true,
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
