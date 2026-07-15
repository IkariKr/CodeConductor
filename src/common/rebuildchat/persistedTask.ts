import type { EditablePromptQueueItem } from './editablePromptQueue';
import { getStartTurnInputValue } from './manualStart';
import type { QuotaRetryDirectiveSource } from './quotaRetryParser';
import type { RunEndReason, RunLogKind, RunStatus, RebuildChatTurnRecord } from './rebuildChatExecutor';

export type RebuildChatPersistedTaskStatus = 'idle' | 'running' | 'paused' | 'stopping' | 'waiting_retry' | 'completed' | 'failed' | 'aborted';
export type RebuildChatActiveTurnState = 'idle' | 'running' | 'completed_not_advanced';

export interface RebuildChatPersistedRetryState {
  reason: 'quota';
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

export interface RebuildChatPersistedTaskSource {
  filePath: string;
  rawContent: string;
  excludeThought: boolean;
  selectedRoles: string[];
}

export interface RebuildChatPersistedTaskProgress {
  conversationId: string | null;
  currentTurnIndex: number;
  effectiveMaxRounds: number;
  runEndReason: RunEndReason;
  runLogs: RebuildChatPersistedLogEntry[];
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
      const hasValidRetryState = typeof retryState === 'undefined' || retryState === null || (typeof retryState === 'object' && retryState.reason === 'quota' && (typeof retryState.retryAt === 'number' || retryState.retryAt === null) && typeof retryState.retryDelayMs === 'number' && typeof retryState.retryAttemptCount === 'number' && typeof retryState.resumeTurnIndex === 'number' && typeof retryState.lastMatchedMessage === 'string' && (retryState.source === 'output' || retryState.source === 'rawLog'));
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
        typeof candidate.stopOnNoChanges === 'boolean' &&
        typeof candidate.skipPermissions === 'boolean' &&
        Boolean(candidate.progress) &&
        typeof candidate.progress?.currentTurnIndex === 'number' &&
        typeof candidate.progress?.effectiveMaxRounds === 'number' &&
        Array.isArray(candidate.progress?.runLogs) &&
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
          startTurnInput: typeof candidate.startTurnInput === 'string' ? candidate.startTurnInput : getStartTurnInputValue(currentTurnIndex, queueLength),
          reuseConversationOnManualStart: typeof candidate.reuseConversationOnManualStart === 'boolean' ? candidate.reuseConversationOnManualStart : false,
        },
      ];
    })
  );
};
