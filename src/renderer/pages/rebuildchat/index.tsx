import { ipcBridge } from '@/common';
import { getConversationResetValidationMessage, getNextConversationRoundCount, parseConversationResetEveryNRounds, shouldResetConversationBeforeTurn } from '@/common/rebuildchat/conversationReset';
import { appendCustomPromptQueueItem, createEditablePromptQueue, removeEditablePromptQueueItems, updateEditablePromptQueueItem, type EditablePromptQueueItem } from '@/common/rebuildchat/editablePromptQueue';
import { DEFAULT_EXECUTION_ERROR_RETRY_COUNT_INPUT, getExecutionErrorRetryValidationMessage, parseExecutionErrorRetryCount } from '@/common/rebuildchat/executionErrorRetry';
import { DEFAULT_EXECUTION_TIMEOUT_MINUTES_INPUT, getExecutionTimeoutMs, getExecutionTimeoutValidationMessage, parseExecutionTimeoutMinutes } from '@/common/rebuildchat/executionTimeout';
import { getStartTurnInputValue, resolveManualStartConversationId, resolveRequestedStartIndex } from '@/common/rebuildchat/manualStart';
import { getPersistedTaskStatus, getRebuildChatTaskResumeIndex, sortRebuildChatTaskSummaries, toRebuildChatPersistedTaskMeta, toRebuildChatPersistedTaskSourceSnapshot, toRebuildChatPersistedTaskSummaryFromMeta, type RebuildChatActiveTurnState, type RebuildChatPersistedLogEntry, type RebuildChatPersistedRetryState, type RebuildChatPersistedStartPromptRecord, type RebuildChatPersistedTask, type RebuildChatPersistedTaskMeta, type RebuildChatPersistedTaskPreview, type RebuildChatPersistedTaskSummary, type RebuildChatPersistedTurnRecord, type RebuildChatRetryPhase, type RebuildChatStartPromptTrigger, type RebuildChatTaskHistoryKind } from '@/common/rebuildchat/persistedTask';
import { parsePromptFile, type ParsePromptFileResult } from '@/common/rebuildchat/promptFileParser';
import { executeRebuildChatRun, type RebuildChatExecuteTurnResult, type RunEndReason, type RunLogKind, type RunStatus } from '@/common/rebuildchat/rebuildChatExecutor';
import { parseQuotaRetry } from '@/common/rebuildchat/quotaRetryParser';
import { parseError, uuid } from '@/common/utils';
import { Message } from '@arco-design/web-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InputPanel from './components/InputPanel';
import ObservePanel from './components/ObservePanel';
import ParseSummaryPanel from './components/ParseSummaryPanel';
import QueueEditorPanel from './components/QueueEditorPanel';
import RetryCountdownNotice from './components/RetryCountdownNotice';
import RunConfigDrawer from './components/RunConfigDrawer';
import RunLogPanel from './components/RunLogPanel';
import TaskListPanel from './components/TaskListPanel';
import TopStatusBar from './components/TopStatusBar';
import { getRebuildChatRuntimeDriver, type AgyTurnExecution, type AgyTurnResult } from './runtime';
import styles from './index.module.css';
import { appendRebuildChatStartPromptRecord, appendRebuildChatTaskLog, appendRebuildChatTurnRecord, clearRebuildChatTasks, deleteRebuildChatTask, loadRebuildChatTaskHistorySlice, loadRebuildChatTaskPreview, loadRebuildChatTasks, replaceRebuildChatTaskSource, upsertRebuildChatTaskMeta } from './taskStorage';
import { formatRetryClock, formatRetryDelay, formatRetryRemaining, getRetryPhaseLabel, getTaskTitle } from './viewLabels';

type RunLogEntry = RebuildChatPersistedLogEntry;
type RetryState = RebuildChatPersistedRetryState;
type StartPromptRecord = RebuildChatPersistedStartPromptRecord;
type TurnRecord = RebuildChatPersistedTurnRecord;
type RebuildChatTaskMetaOverrides = Omit<Partial<RebuildChatPersistedTaskMeta>, 'progress' | 'source'> & {
  progress?: Partial<RebuildChatPersistedTaskMeta['progress']>;
  source?: Partial<RebuildChatPersistedTaskMeta['source']>;
};

interface RebuildChatSeedPromptFilePayload {
  filePath: string;
  rawContent: string;
  watchDir?: string;
  workDir?: string;
}

interface RebuildChatRunConfigPayload {
  conversationResetEveryNRoundsInput?: string;
  executionErrorRetryCountInput?: string;
  executionTimeoutMinutesInput?: string;
  includeHistoryContext?: boolean;
  maxRoundsInput?: string;
  reuseConversationOnManualStart?: boolean;
  skipTurnOnNoOutput?: boolean;
  skipPermissions?: boolean;
  startPromptInput?: string;
  startTurnInput?: string;
  watchDir?: string;
  watchExtensionsInput?: string;
  workDir?: string;
}

interface RebuildChatFilePickerOverride {
  filePath: string;
  rawContent: string;
  watchDir?: string;
  workDir?: string;
}

interface StartRunWithFreshTaskParams {
  effectiveWatchDir: string;
  forceFork?: boolean;
  initialConversationId: string | null;
  initialConversationRoundCount?: number;
  reuseConversationOnManualStartValue?: boolean;
  seedLogs: RunLogEntry[];
  startIndex: number;
  startTurnInputValue?: string;
}

interface RebuildChatTestApi {
  clearPersistedTasks: () => Promise<void>;
  flushPersistedTasks: () => Promise<void>;
  getState: () => {
    conversationId: string | null;
    conversationResetEveryNRoundsInput: string;
    currentConversationRoundCount: number;
    currentTurnIndex: number;
    currentTaskId: string | null;
    effectiveMaxRounds: number;
    executionErrorRetryCountInput: string;
    executionTimeoutMinutesInput: string;
    hasSentStartPromptInCurrentConversation: boolean;
    persistedCurrentTurnIndex: number | null;
    persistedTaskCount: number;
    queueLength: number;
    retryAttemptCount: number | null;
    retryAt: number | null;
    reuseConversationOnManualStart: boolean;
    runEndReason: RunEndReason;
    runLogCount: number;
    runStatus: RunStatus;
    skipTurnOnNoOutput: boolean;
    startPromptInput: string;
    startPromptRecordCount: number;
    startTurnInput: string;
    taskNotice: string;
    turnRecordCount: number;
    watchDir: string;
    workDir: string;
  };
  resumePersistedTask: (index: number) => Promise<void>;
  seedPromptFile: (payload: RebuildChatSeedPromptFilePayload) => void;
  setRunConfig: (payload: RebuildChatRunConfigPayload) => void;
}

interface TimedExecutionResult<TExecutionResult> {
  attempts: number;
  conversationId: string | null;
  result?: TExecutionResult;
  status: 'completed' | 'paused_timeout';
}

interface ResilientExecutionResult<TExecutionResult> {
  conversationId: string | null;
  result?: TExecutionResult;
  status: 'completed' | 'paused_error' | 'paused_timeout';
}

type MaybeConversationId = string | null;
type TimedAgyResult = TimedExecutionResult<AgyTurnResult>;
type ResilientAgyResult = ResilientExecutionResult<AgyTurnResult>;
type StartAgyExecution = (conversationId: MaybeConversationId) => Promise<AgyTurnExecution>;

const DEFAULT_HISTORY_PAGE_SIZE = 50;

interface RunAgyExecutionWithTimeout {
  (phase: RebuildChatRetryPhase, label: string, exec: StartAgyExecution, initialConversationId: MaybeConversationId, timeoutMinutes: number): Promise<TimedAgyResult>;
}

interface RunAgyExecutionWithRecovery {
  (phase: RebuildChatRetryPhase, label: string, exec: StartAgyExecution, initialConversationId: MaybeConversationId, timeoutMinutes: number, errorRetryCount: number): Promise<ResilientAgyResult>;
}

declare global {
  interface Window {
    __REBUILDCHAT_FILE_PICKER_OVERRIDE__?: RebuildChatFilePickerOverride;
    __REBUILDCHAT_TEST_API__?: RebuildChatTestApi;
    __REBUILDCHAT_TIMEOUT_OVERRIDE_MS__?: number;
  }
}

const normalizeLoadedRunStatus = (task: RebuildChatPersistedTask): RunStatus => {
  if (task.status === 'running' || task.status === 'stopping') {
    return 'paused';
  }

  if (task.status === 'aborted') {
    return 'completed';
  }

  if (task.status === 'idle' || task.status === 'paused' || task.status === 'waiting_retry' || task.status === 'completed' || task.status === 'failed') {
    return task.status;
  }

  return 'idle';
};

const createRunLogEntry = (kind: RunLogKind, text: string): RunLogEntry => ({
  id: `log-${uuid(12)}`,
  kind,
  text,
  timestamp: new Date().toLocaleTimeString(),
});

const createStartPromptRecord = (trigger: RebuildChatStartPromptTrigger, targetTurnIndex: number, prompt: string, output: string, status: StartPromptRecord['status'], conversationId: string | null): StartPromptRecord => ({
  id: `start-prompt-${uuid(12)}`,
  trigger,
  targetTurnIndex,
  prompt,
  output,
  status,
  conversationId,
  timestamp: new Date().toLocaleTimeString(),
});

const takeLastEntries = <T,>(entries: T[], maxEntries: number): T[] => {
  if (entries.length <= maxEntries) {
    return entries;
  }

  return entries.slice(-maxEntries);
};

interface TaskPayloadSignatureState {
  activeTurnState: RebuildChatActiveTurnState;
  conversationId: string | null;
  currentTurnIndex: number;
  filePath: string;
  pendingStartPromptTrigger: RebuildChatStartPromptTrigger | null;
  queue: EditablePromptQueueItem[];
  rawContent: string;
  retryState: RetryState | null;
  runEndReason: RunEndReason;
  runLogs: RunLogEntry[];
  runStatus: RunStatus;
  startPromptRecords: StartPromptRecord[];
  turnRecords: TurnRecord[];
}

const getTaskPayloadSignature = (state: TaskPayloadSignatureState): string => {
  return [state.filePath, state.rawContent.length, state.queue.length, state.runLogs.length, state.startPromptRecords.length, state.turnRecords.length, state.currentTurnIndex, state.runStatus, state.runEndReason ?? '', state.activeTurnState, state.conversationId ?? '', state.pendingStartPromptTrigger ?? '', state.retryState?.retryAttemptCount ?? '', state.retryState?.retryAt ?? ''].join('|');
};

const computeEffectiveMaxRounds = (maxRoundsValue: string, queueLength: number) => {
  const parsed = Number(maxRoundsValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return queueLength;
  }
  return Math.min(queueLength, Math.floor(parsed));
};

const getStartTurnValidationMessage = (error: 'empty' | 'invalid' | 'out_of_range', queueLength: number): string => {
  switch (error) {
    case 'empty':
      return '请先填写起始轮次。';
    case 'invalid':
      return '起始轮次必须是正整数。';
    case 'out_of_range':
      return `起始轮次必须在 1 到 ${Math.max(queueLength, 1)} 之间。`;
    default:
      return '起始轮次无效。';
  }
};

const RebuildChatPage: React.FC = () => {
  const [filePath, setFilePath] = useState('');
  const [rawContent, setRawContent] = useState('');
  const [excludeThought, setExcludeThought] = useState(true);
  const [parseResult, setParseResult] = useState<ParsePromptFileResult | null>(null);
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [queue, setQueue] = useState<EditablePromptQueueItem[]>([]);
  const [selectedQueueIds, setSelectedQueueIds] = useState<string[]>([]);
  const [errorText, setErrorText] = useState('');
  const [loading, setLoading] = useState(false);

  const [workDir, setWorkDir] = useState('');
  const [watchDir, setWatchDir] = useState('');
  const [watchExtensionsInput, setWatchExtensionsInput] = useState('');
  const [maxRoundsInput, setMaxRoundsInput] = useState('');
  const [executionErrorRetryCountInput, setExecutionErrorRetryCountInput] = useState(DEFAULT_EXECUTION_ERROR_RETRY_COUNT_INPUT);
  const [executionTimeoutMinutesInput, setExecutionTimeoutMinutesInput] = useState(DEFAULT_EXECUTION_TIMEOUT_MINUTES_INPUT);
  const [conversationResetEveryNRoundsInput, setConversationResetEveryNRoundsInput] = useState('');
  const [startPromptInput, setStartPromptInput] = useState('');
  const [startTurnInput, setStartTurnInput] = useState('1');
  const [includeHistoryContext, setIncludeHistoryContext] = useState(false);
  const [skipTurnOnNoOutput, setSkipTurnOnNoOutput] = useState(true);
  const [skipPermissions, setSkipPermissions] = useState(false);
  const [reuseConversationOnManualStart, setReuseConversationOnManualStart] = useState(false);

  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [runEndReason, setRunEndReason] = useState<RunEndReason>(null);
  const [runLogs, setRunLogs] = useState<RunLogEntry[]>([]);
  const [turnRecords, setTurnRecords] = useState<TurnRecord[]>([]);
  const [runLogTotalCount, setRunLogTotalCount] = useState(0);
  const [turnRecordTotalCount, setTurnRecordTotalCount] = useState(0);
  const [startPromptRecordTotalCount, setStartPromptRecordTotalCount] = useState(0);
  const [_runLogVisibleCount, setRunLogVisibleCount] = useState(DEFAULT_HISTORY_PAGE_SIZE);
  const [_turnRecordVisibleCount, setTurnRecordVisibleCount] = useState(DEFAULT_HISTORY_PAGE_SIZE);
  const [_startPromptRecordVisibleCount, setStartPromptRecordVisibleCount] = useState(DEFAULT_HISTORY_PAGE_SIZE);
  const [historyLoadingState, setHistoryLoadingState] = useState<Record<RebuildChatTaskHistoryKind, boolean>>({
    runLogs: false,
    startPromptRecords: false,
    turnRecords: false,
  });
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [currentConversationRoundCount, setCurrentConversationRoundCount] = useState(0);
  const [hasSentStartPromptInCurrentConversation, setHasSentStartPromptInCurrentConversation] = useState(true);
  const [pendingStartPromptTrigger, setPendingStartPromptTrigger] = useState<RebuildChatStartPromptTrigger | null>(null);
  const [startPromptRecords, setStartPromptRecords] = useState<StartPromptRecord[]>([]);
  const [activeTurnState, setActiveTurnState] = useState<RebuildChatActiveTurnState>('idle');
  const [retryState, setRetryState] = useState<RetryState | null>(null);
  const [persistedTasks, setPersistedTasks] = useState<RebuildChatPersistedTaskSummary[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [taskNotice, setTaskNotice] = useState('');
  const [configDrawerVisible, setConfigDrawerVisible] = useState(false);

  const queueRef = useRef(queue);
  const currentExecutionRef = useRef<AgyTurnExecution | null>(null);
  const currentExecutionPhaseRef = useRef<RebuildChatRetryPhase>('turn');
  const currentExecutionTimeoutRetryCountRef = useRef(0);
  const pauseRequestedRef = useRef(false);
  const abortRequestedRef = useRef(false);
  const queueRebuildSuppressedRef = useRef(0);
  const applyingTaskRef = useRef(false);
  const persistedTasksRef = useRef<RebuildChatPersistedTaskSummary[]>([]);
  const currentTaskIdRef = useRef<string | null>(null);
  const retryTimeoutRef = useRef<number | null>(null);
  const retryAutoResumeRef = useRef(false);
  const deletedTaskSignatureRef = useRef<string | null>(null);
  const turnConversationMetaRef = useRef({
    conversationId: null as string | null,
    currentConversationRoundCount: 0,
  });
  const saveTasksPromiseRef = useRef(Promise.resolve());
  const pendingTaskMetaWriteRef = useRef<RebuildChatPersistedTaskMeta | null>(null);
  const pendingTaskSourceWriteRef = useRef<{ taskId: string; source: ReturnType<typeof toRebuildChatPersistedTaskSourceSnapshot> } | null>(null);
  const pendingTaskRunLogAppendRef = useRef<Array<{ taskId: string; entry: RunLogEntry }>>([]);
  const pendingTaskTurnRecordAppendRef = useRef<Array<{ taskId: string; entry: TurnRecord }>>([]);
  const pendingTaskStartPromptAppendRef = useRef<Array<{ taskId: string; entry: StartPromptRecord }>>([]);
  const taskWriteLoopRef = useRef<Promise<void> | null>(null);
  const historyStateRef = useRef({
    runLogTotalCount: 0,
    startPromptRecordTotalCount: 0,
    turnRecordTotalCount: 0,
    runLogVisibleCount: DEFAULT_HISTORY_PAGE_SIZE,
    startPromptRecordVisibleCount: DEFAULT_HISTORY_PAGE_SIZE,
    turnRecordVisibleCount: DEFAULT_HISTORY_PAGE_SIZE,
  });
  const pageStateRef = useRef({
    filePath: '',
    rawContent: '',
    excludeThought: true,
    selectedRoles: [] as string[],
    queue: [] as EditablePromptQueueItem[],
    workDir: '',
    watchDir: '',
    watchExtensionsInput: '',
    maxRoundsInput: '',
    executionErrorRetryCountInput: DEFAULT_EXECUTION_ERROR_RETRY_COUNT_INPUT,
    executionTimeoutMinutesInput: DEFAULT_EXECUTION_TIMEOUT_MINUTES_INPUT,
    conversationResetEveryNRoundsInput: '',
    startPromptInput: '',
    startTurnInput: '1',
    includeHistoryContext: false,
    skipTurnOnNoOutput: true,
    skipPermissions: false,
    reuseConversationOnManualStart: false,
    runStatus: 'idle' as RunStatus,
    runEndReason: null as RunEndReason,
    runLogs: [] as RunLogEntry[],
    turnRecords: [] as TurnRecord[],
    currentTurnIndex: 0,
    conversationId: null as string | null,
    currentConversationRoundCount: 0,
    hasSentStartPromptInCurrentConversation: true,
    pendingStartPromptTrigger: null as RebuildChatStartPromptTrigger | null,
    startPromptRecords: [] as StartPromptRecord[],
    activeTurnState: 'idle' as RebuildChatActiveTurnState,
    retryState: null as RetryState | null,
  });

  const commitPersistedTaskSummaries = (tasks: RebuildChatPersistedTaskSummary[]) => {
    const nextTasks = sortRebuildChatTaskSummaries(tasks);
    persistedTasksRef.current = nextTasks;
    setPersistedTasks(nextTasks);
    return nextTasks;
  };

  const getTaskWriteBarrier = () => {
    return taskWriteLoopRef.current ?? Promise.resolve();
  };

  const buildPersistedTaskBase = (taskId: string, createdAt: number): RebuildChatPersistedTask => {
    const state = pageStateRef.current;
    return {
      taskId,
      createdAt,
      updatedAt: Date.now(),
      status: getPersistedTaskStatus(state.runStatus, state.runEndReason),
      source: {
        filePath: state.filePath,
        rawContent: state.rawContent,
        excludeThought: state.excludeThought,
        selectedRoles: [...state.selectedRoles],
      },
      queueSnapshot: state.queue.map((item) => ({ ...item })),
      workDir: state.workDir,
      watchDir: state.watchDir,
      watchExtensionsInput: state.watchExtensionsInput,
      includeHistoryContext: state.includeHistoryContext,
      maxRoundsInput: state.maxRoundsInput,
      executionErrorRetryCountInput: state.executionErrorRetryCountInput,
      executionTimeoutMinutesInput: state.executionTimeoutMinutesInput,
      conversationResetEveryNRoundsInput: state.conversationResetEveryNRoundsInput,
      startPromptInput: state.startPromptInput,
      startTurnInput: state.startTurnInput,
      skipTurnOnNoOutput: state.skipTurnOnNoOutput,
      skipPermissions: state.skipPermissions,
      reuseConversationOnManualStart: state.reuseConversationOnManualStart,
      progress: {
        conversationId: state.conversationId,
        currentConversationRoundCount: state.currentConversationRoundCount,
        currentTurnIndex: state.currentTurnIndex,
        effectiveMaxRounds: computeEffectiveMaxRounds(state.maxRoundsInput, state.queue.length),
        hasSentStartPromptInCurrentConversation: state.hasSentStartPromptInCurrentConversation,
        pendingStartPromptTrigger: state.pendingStartPromptTrigger,
        runEndReason: state.runEndReason,
        runLogs: state.runLogs.map((entry) => ({ ...entry })),
        startPromptRecords: state.startPromptRecords.map((record) => ({ ...record })),
        turnRecords: state.turnRecords.map((record) => ({ ...record })),
        activeTurnState: state.activeTurnState,
        retryState: state.retryState ? { ...state.retryState } : null,
      },
    };
  };

  const buildPersistedTaskMeta = (taskId: string, createdAt: number, overrides: RebuildChatTaskMetaOverrides = {}): RebuildChatPersistedTaskMeta => {
    const baseMeta = toRebuildChatPersistedTaskMeta(buildPersistedTaskBase(taskId, createdAt));
    baseMeta.progress.runLogCount = historyStateRef.current.runLogTotalCount;
    baseMeta.progress.startPromptRecordCount = historyStateRef.current.startPromptRecordTotalCount;
    baseMeta.progress.turnRecordCount = historyStateRef.current.turnRecordTotalCount;

    return {
      ...baseMeta,
      ...overrides,
      source: {
        ...baseMeta.source,
        ...(overrides.source || {}),
      },
      progress: {
        ...baseMeta.progress,
        ...(overrides.progress || {}),
      },
    };
  };

  const buildPersistedTaskSourceSnapshot = (taskId: string, createdAt: number) => {
    return toRebuildChatPersistedTaskSourceSnapshot(buildPersistedTaskBase(taskId, createdAt));
  };

  const queueTaskMetaWrite = (meta: RebuildChatPersistedTaskMeta) => {
    const nextSummary = toRebuildChatPersistedTaskSummaryFromMeta(meta);
    commitPersistedTaskSummaries([nextSummary, ...persistedTasksRef.current.filter((item) => item.taskId !== meta.taskId)]);
    pendingTaskMetaWriteRef.current = meta;
    saveTasksPromiseRef.current = startTaskWriteLoop();
  };

  const queueTaskSourceWrite = (taskId: string, source: ReturnType<typeof toRebuildChatPersistedTaskSourceSnapshot>) => {
    pendingTaskSourceWriteRef.current = {
      taskId,
      source,
    };
    saveTasksPromiseRef.current = startTaskWriteLoop();
  };

  const queueTaskHistoryAppend = (kind: RebuildChatTaskHistoryKind, taskId: string, entry: RunLogEntry | TurnRecord | StartPromptRecord) => {
    if (kind === 'runLogs') {
      pendingTaskRunLogAppendRef.current.push({ taskId, entry: entry as RunLogEntry });
    } else if (kind === 'turnRecords') {
      pendingTaskTurnRecordAppendRef.current.push({ taskId, entry: entry as TurnRecord });
    } else {
      pendingTaskStartPromptAppendRef.current.push({ taskId, entry: entry as StartPromptRecord });
    }
    saveTasksPromiseRef.current = startTaskWriteLoop();
  };

  const hasPendingTaskWrites = () => {
    // eslint-disable-next-line max-len
    return Boolean(pendingTaskMetaWriteRef.current || pendingTaskSourceWriteRef.current || pendingTaskRunLogAppendRef.current.length || pendingTaskTurnRecordAppendRef.current.length || pendingTaskStartPromptAppendRef.current.length);
  };

  const startTaskWriteLoop = () => {
    if (taskWriteLoopRef.current) {
      return taskWriteLoopRef.current;
    }

    const writeLoop = (async () => {
      while (hasPendingTaskWrites()) {
        const nextMeta = pendingTaskMetaWriteRef.current;
        const nextSource = pendingTaskSourceWriteRef.current;
        const nextRunLogs = pendingTaskRunLogAppendRef.current.splice(0);
        const nextTurnRecords = pendingTaskTurnRecordAppendRef.current.splice(0);
        const nextStartPromptRecords = pendingTaskStartPromptAppendRef.current.splice(0);

        pendingTaskMetaWriteRef.current = null;
        pendingTaskSourceWriteRef.current = null;

        try {
          if (nextSource) {
            await replaceRebuildChatTaskSource(nextSource.taskId, nextSource.source);
          }

          for (const item of nextRunLogs) {
            await appendRebuildChatTaskLog(item.taskId, item.entry);
          }

          for (const item of nextTurnRecords) {
            await appendRebuildChatTurnRecord(item.taskId, item.entry);
          }

          for (const item of nextStartPromptRecords) {
            await appendRebuildChatStartPromptRecord(item.taskId, item.entry);
          }

          if (nextMeta) {
            const writtenTasks = await upsertRebuildChatTaskMeta(nextMeta);
            commitPersistedTaskSummaries(writtenTasks);
          }
        } catch (error) {
          console.error('[RebuildChat] Failed to save task:', error);
        }
      }
    })().finally(() => {
      taskWriteLoopRef.current = null;
      if (hasPendingTaskWrites()) {
        saveTasksPromiseRef.current = startTaskWriteLoop();
      }
    });

    taskWriteLoopRef.current = writeLoop;
    return writeLoop;
  };

  const hasTaskPayload = () => {
    const state = pageStateRef.current;
    return Boolean(state.filePath || state.rawContent || state.queue.length || state.runLogs.length || state.startPromptRecords.length || state.turnRecords.length);
  };

  const ensureCurrentTask = () => {
    if (currentTaskIdRef.current) {
      return currentTaskIdRef.current;
    }

    if (!hasTaskPayload()) {
      return null;
    }

    const taskId = uuid();
    const createdAt = Date.now();
    queueTaskSourceWrite(taskId, buildPersistedTaskSourceSnapshot(taskId, createdAt));
    queueTaskMetaWrite(buildPersistedTaskMeta(taskId, createdAt));
    currentTaskIdRef.current = taskId;
    setCurrentTaskId(taskId);
    return taskId;
  };

  const persistCurrentTask = (overrides: RebuildChatTaskMetaOverrides = {}) => {
    const taskId = ensureCurrentTask();
    if (!taskId) {
      return null;
    }

    const existing = persistedTasksRef.current.find((task) => task.taskId === taskId);
    const createdAt = existing?.createdAt ?? Date.now();
    const nextMeta = buildPersistedTaskMeta(taskId, createdAt, overrides);
    queueTaskMetaWrite(nextMeta);
    return nextMeta;
  };

  const persistCurrentTaskSource = () => {
    const taskId = ensureCurrentTask();
    if (!taskId) {
      return null;
    }

    const createdAt = persistedTasksRef.current.find((task) => task.taskId === taskId)?.createdAt ?? Date.now();
    queueTaskSourceWrite(taskId, buildPersistedTaskSourceSnapshot(taskId, createdAt));
    queueTaskMetaWrite(buildPersistedTaskMeta(taskId, createdAt));
    return taskId;
  };

  const clearPersistedTasks = async () => {
    currentTaskIdRef.current = null;
    setCurrentTaskId(null);
    commitPersistedTaskSummaries([]);
    pendingTaskMetaWriteRef.current = null;
    pendingTaskSourceWriteRef.current = null;
    pendingTaskRunLogAppendRef.current = [];
    pendingTaskTurnRecordAppendRef.current = [];
    pendingTaskStartPromptAppendRef.current = [];
    saveTasksPromiseRef.current = getTaskWriteBarrier()
      .then(() => clearRebuildChatTasks())
      .catch((error) => {
        console.error('[RebuildChat] Failed to clear tasks:', error);
      });
    await saveTasksPromiseRef.current;
  };

  const flushPersistedTasks = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    if (tasksLoaded && !applyingTaskRef.current) {
      const taskId = currentTaskIdRef.current ?? ensureCurrentTask();
      if (taskId) {
        const createdAt = persistedTasksRef.current.find((task) => task.taskId === taskId)?.createdAt ?? Date.now();
        queueTaskSourceWrite(taskId, buildPersistedTaskSourceSnapshot(taskId, createdAt));
        queueTaskMetaWrite(buildPersistedTaskMeta(taskId, createdAt));
      }
    }
    await saveTasksPromiseRef.current;
  };

  const getPersistedCurrentTurnIndex = () => {
    if (currentTaskIdRef.current) {
      return persistedTasksRef.current.find((task) => task.taskId === currentTaskIdRef.current)?.progress.currentTurnIndex ?? null;
    }

    return persistedTasksRef.current[0]?.progress.currentTurnIndex ?? null;
  };

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  useEffect(() => {
    currentTaskIdRef.current = currentTaskId;
  }, [currentTaskId]);

  useEffect(() => {
    persistedTasksRef.current = persistedTasks;
  }, [persistedTasks]);

  useEffect(() => {
    pageStateRef.current = {
      filePath,
      rawContent,
      excludeThought,
      selectedRoles,
      queue,
      workDir,
      watchDir,
      watchExtensionsInput,
      maxRoundsInput,
      executionErrorRetryCountInput,
      executionTimeoutMinutesInput,
      conversationResetEveryNRoundsInput,
      startPromptInput,
      startTurnInput,
      includeHistoryContext,
      skipTurnOnNoOutput,
      skipPermissions,
      reuseConversationOnManualStart,
      runStatus,
      runEndReason,
      runLogs,
      turnRecords,
      currentTurnIndex,
      conversationId,
      currentConversationRoundCount,
      hasSentStartPromptInCurrentConversation,
      pendingStartPromptTrigger,
      startPromptRecords,
      activeTurnState,
      retryState,
    };
    // eslint-disable-next-line max-len
  }, [activeTurnState, conversationId, conversationResetEveryNRoundsInput, currentConversationRoundCount, currentTurnIndex, executionErrorRetryCountInput, executionTimeoutMinutesInput, excludeThought, filePath, hasSentStartPromptInCurrentConversation, includeHistoryContext, maxRoundsInput, pendingStartPromptTrigger, queue, rawContent, retryState, reuseConversationOnManualStart, runEndReason, runLogs, runStatus, selectedRoles, skipPermissions, skipTurnOnNoOutput, startPromptInput, startPromptRecords, startTurnInput, turnRecords, watchDir, watchExtensionsInput, workDir]);

  useEffect(() => {
    void loadRebuildChatTasks()
      .then((tasks) => {
        persistedTasksRef.current = tasks;
        setPersistedTasks(tasks);
      })
      .finally(() => {
        setTasksLoaded(true);
      });
  }, []);

  useEffect(() => {
    if (!rawContent) {
      setParseResult(null);
      setSelectedRoles([]);
      return;
    }

    try {
      const nextParseResult = parsePromptFile(rawContent, { excludeThought });
      setParseResult(nextParseResult);
      setErrorText('');
      setSelectedRoles((previous) => {
        const nextSelected = previous.filter((role) => nextParseResult.availableRoles.includes(role));
        return nextSelected.length ? nextSelected : nextParseResult.availableRoles;
      });
    } catch (error) {
      setParseResult(null);
      setSelectedRoles([]);
      setErrorText(parseError(error));
    }
  }, [excludeThought, rawContent]);

  const filteredChunks = useMemo(() => {
    if (!parseResult) return [];
    if (!selectedRoles.length) return [];
    return parseResult.chunks.filter((chunk) => selectedRoles.includes(chunk.role));
  }, [parseResult, selectedRoles]);

  useEffect(() => {
    if (queueRebuildSuppressedRef.current > 0) {
      queueRebuildSuppressedRef.current -= 1;
      return;
    }

    setQueue(createEditablePromptQueue(filteredChunks));
    setSelectedQueueIds([]);
    setCurrentTurnIndex(0);
    setActiveTurnState('idle');
    setStartTurnInput(getStartTurnInputValue(0, filteredChunks.length));
  }, [filteredChunks]);

  const queueStats = useMemo(() => {
    const editedCount = queue.filter((item) => item.edited).length;
    const customCount = queue.filter((item) => item.isCustom).length;

    return {
      total: queue.length,
      editedCount,
      customCount,
    };
  }, [queue]);

  const displayedStartPromptRecords = useMemo(() => {
    return [...startPromptRecords].reverse();
  }, [startPromptRecords]);

  const displayedTurnRecords = useMemo(() => {
    return [...turnRecords].reverse();
  }, [turnRecords]);

  const effectiveMaxRounds = useMemo(() => {
    return computeEffectiveMaxRounds(maxRoundsInput, queue.length);
  }, [maxRoundsInput, queue.length]);

  const isRunLocked = runStatus === 'running' || runStatus === 'stopping' || runStatus === 'waiting_retry';
  const syncStartTurnInputToIndex = (index: number, queueLengthOverride?: number) => {
    const queueLength = typeof queueLengthOverride === 'number' ? queueLengthOverride : pageStateRef.current.queue.length;
    setStartTurnInput(getStartTurnInputValue(index, queueLength));
  };

  const resolveRequestedStart = (fallbackIndex: number, startTurnValue: string = pageStateRef.current.startTurnInput) => {
    const resolved = resolveRequestedStartIndex({
      fallbackIndex,
      queueLength: queueRef.current.length,
      startTurnInput: startTurnValue,
    });

    if (resolved.ok === false) {
      Message.warning(getStartTurnValidationMessage(resolved.error, queueRef.current.length));
      return null;
    }

    return resolved;
  };

  const resolveConversationResetInterval = (input: string = pageStateRef.current.conversationResetEveryNRoundsInput) => {
    const parsed = parseConversationResetEveryNRounds(input);
    if (parsed.error) {
      Message.warning(getConversationResetValidationMessage(parsed.error));
      return null;
    }

    return parsed.value;
  };

  const resolveExecutionTimeoutMinutes = (input: string = pageStateRef.current.executionTimeoutMinutesInput) => {
    const parsed = parseExecutionTimeoutMinutes(input);
    if (parsed.error) {
      Message.warning(getExecutionTimeoutValidationMessage(parsed.error));
      return null;
    }

    return parsed.value;
  };

  const resolveExecutionErrorRetryCount = (input: string = pageStateRef.current.executionErrorRetryCountInput) => {
    const parsed = parseExecutionErrorRetryCount(input);
    if (parsed.error) {
      Message.warning(getExecutionErrorRetryValidationMessage(parsed.error));
      return null;
    }

    return parsed.value;
  };

  const appendRunLog = (kind: RunLogKind, text: string) => {
    const nextEntry = createRunLogEntry(kind, text);
    const nextTotalCount = historyStateRef.current.runLogTotalCount + 1;
    const nextLogs = takeLastEntries([...pageStateRef.current.runLogs, nextEntry], historyStateRef.current.runLogVisibleCount);
    pageStateRef.current.runLogs = nextLogs;
    historyStateRef.current.runLogTotalCount = nextTotalCount;
    setRunLogs(nextLogs);
    setRunLogTotalCount(nextTotalCount);

    const taskId = ensureCurrentTask();
    if (taskId) {
      queueTaskHistoryAppend('runLogs', taskId, nextEntry);
      persistCurrentTask({
        progress: {
          runLogCount: nextTotalCount,
        },
      });
    }
  };

  const clearRetryTimeout = () => {
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  };

  const resetRunState = () => {
    currentExecutionPhaseRef.current = 'turn';
    currentExecutionTimeoutRetryCountRef.current = 0;
    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    retryAutoResumeRef.current = false;
    clearRetryTimeout();
    currentExecutionRef.current = null;
    setRunStatus('idle');
    setRunEndReason(null);
    setRunLogs([]);
    setTurnRecords([]);
    setRunLogTotalCount(0);
    setTurnRecordTotalCount(0);
    setStartPromptRecordTotalCount(0);
    setRunLogVisibleCount(DEFAULT_HISTORY_PAGE_SIZE);
    setTurnRecordVisibleCount(DEFAULT_HISTORY_PAGE_SIZE);
    setStartPromptRecordVisibleCount(DEFAULT_HISTORY_PAGE_SIZE);
    setHistoryLoadingState({
      runLogs: false,
      startPromptRecords: false,
      turnRecords: false,
    });
    setCurrentTurnIndex(0);
    setConversationId(null);
    setCurrentConversationRoundCount(0);
    setHasSentStartPromptInCurrentConversation(true);
    setPendingStartPromptTrigger(null);
    setStartPromptRecords([]);
    turnConversationMetaRef.current = {
      conversationId: null,
      currentConversationRoundCount: 0,
    };
    historyStateRef.current = {
      runLogTotalCount: 0,
      startPromptRecordTotalCount: 0,
      turnRecordTotalCount: 0,
      runLogVisibleCount: DEFAULT_HISTORY_PAGE_SIZE,
      startPromptRecordVisibleCount: DEFAULT_HISTORY_PAGE_SIZE,
      turnRecordVisibleCount: DEFAULT_HISTORY_PAGE_SIZE,
    };
    setActiveTurnState('idle');
    setRetryState(null);
    syncStartTurnInputToIndex(0, queueRef.current.length);
    setSelectedQueueIds([]);
    setTaskNotice('');
  };

  const applyPromptFileSelection = (nextPath: string, nextContent: string, nextWorkDir?: string, nextWatchDir?: string, resetTaskContext: boolean = true) => {
    const nextParentDir = getRebuildChatRuntimeDriver().getParentDirectory(nextPath);

    if (resetTaskContext) {
      currentTaskIdRef.current = null;
      setCurrentTaskId(null);
      resetRunState();
    }

    setFilePath(nextPath);
    setRawContent(nextContent);
    setErrorText('');
    setWorkDir((previous) => nextWorkDir || previous || nextParentDir);
    setWatchDir((previous) => nextWatchDir || previous || nextParentDir);
  };

  const seedPromptFileForTestApi = (payload: RebuildChatSeedPromptFilePayload) => {
    const { filePath: nextPath, rawContent: nextContent, workDir: nextWorkDir, watchDir: nextWatchDir } = payload;
    applyPromptFileSelection(nextPath, nextContent, nextWorkDir, nextWatchDir, true);
  };

  const setRunConfigForTestApi = (payload: RebuildChatRunConfigPayload) => {
    const nextWorkDir = payload.workDir;
    const nextWatchDir = payload.watchDir;
    const nextWatchExtensions = payload.watchExtensionsInput;
    const nextMaxRounds = payload.maxRoundsInput;
    const nextExecutionErrorRetryCount = payload.executionErrorRetryCountInput;
    const nextExecutionTimeoutMinutes = payload.executionTimeoutMinutesInput;
    const nextConversationResetEveryNRounds = payload.conversationResetEveryNRoundsInput;
    const nextStartPrompt = payload.startPromptInput;
    const nextStartTurn = payload.startTurnInput;
    const nextIncludeHistory = payload.includeHistoryContext;
    const nextSkipTurnOnNoOutput = payload.skipTurnOnNoOutput;
    const nextSkipPermissions = payload.skipPermissions;
    const nextReuseConversation = payload.reuseConversationOnManualStart;

    if (typeof nextWorkDir === 'string') setWorkDir(nextWorkDir);
    if (typeof nextWatchDir === 'string') setWatchDir(nextWatchDir);
    if (typeof nextWatchExtensions === 'string') setWatchExtensionsInput(nextWatchExtensions);
    if (typeof nextMaxRounds === 'string') setMaxRoundsInput(nextMaxRounds);
    if (typeof nextExecutionErrorRetryCount === 'string') setExecutionErrorRetryCountInput(nextExecutionErrorRetryCount);
    if (typeof nextExecutionTimeoutMinutes === 'string') setExecutionTimeoutMinutesInput(nextExecutionTimeoutMinutes);
    if (typeof nextConversationResetEveryNRounds === 'string') setConversationResetEveryNRoundsInput(nextConversationResetEveryNRounds);
    if (typeof nextStartPrompt === 'string') setStartPromptInput(nextStartPrompt);
    if (typeof nextStartTurn === 'string') setStartTurnInput(nextStartTurn);
    if (typeof nextIncludeHistory === 'boolean') setIncludeHistoryContext(nextIncludeHistory);
    if (typeof nextSkipTurnOnNoOutput === 'boolean') setSkipTurnOnNoOutput(nextSkipTurnOnNoOutput);
    if (typeof nextSkipPermissions === 'boolean') setSkipPermissions(nextSkipPermissions);
    if (typeof nextReuseConversation === 'boolean') setReuseConversationOnManualStart(nextReuseConversation);
  };

  const finishRun = (status: RunStatus, reason: RunEndReason, nextTurnIndex?: number) => {
    currentExecutionPhaseRef.current = 'turn';
    currentExecutionTimeoutRetryCountRef.current = 0;
    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    retryAutoResumeRef.current = false;
    clearRetryTimeout();
    currentExecutionRef.current = null;
    setRunStatus(status);
    setRunEndReason(reason);
    setActiveTurnState('idle');
    setRetryState(null);
    setConversationId(turnConversationMetaRef.current.conversationId);
    setCurrentConversationRoundCount(turnConversationMetaRef.current.currentConversationRoundCount);
    pageStateRef.current.conversationId = turnConversationMetaRef.current.conversationId;
    pageStateRef.current.currentConversationRoundCount = turnConversationMetaRef.current.currentConversationRoundCount;
    if (typeof nextTurnIndex === 'number') {
      setCurrentTurnIndex(nextTurnIndex);
      syncStartTurnInputToIndex(nextTurnIndex);
      pageStateRef.current.currentTurnIndex = nextTurnIndex;
    }
    persistCurrentTask({
      status: getPersistedTaskStatus(status, reason),
      progress: {
        conversationId: turnConversationMetaRef.current.conversationId,
        currentConversationRoundCount: turnConversationMetaRef.current.currentConversationRoundCount,
        currentTurnIndex: typeof nextTurnIndex === 'number' ? nextTurnIndex : pageStateRef.current.currentTurnIndex,
        hasSentStartPromptInCurrentConversation: pageStateRef.current.hasSentStartPromptInCurrentConversation,
        pendingStartPromptTrigger: pageStateRef.current.pendingStartPromptTrigger,
        runEndReason: reason,
        activeTurnState: 'idle',
        retryState: null,
      },
    });
  };

  useEffect(() => {
    if (!tasksLoaded || applyingTaskRef.current) {
      return;
    }

    if (!currentTaskIdRef.current) {
      if (!hasTaskPayload()) {
        return;
      }
      const nextSignature = getTaskPayloadSignature(pageStateRef.current);
      if (deletedTaskSignatureRef.current === nextSignature) {
        return;
      }
      deletedTaskSignatureRef.current = null;
      ensureCurrentTask();
      return;
    }

    persistCurrentTask();
    // eslint-disable-next-line max-len
  }, [activeTurnState, conversationId, currentTurnIndex, currentConversationRoundCount, executionErrorRetryCountInput, executionTimeoutMinutesInput, hasSentStartPromptInCurrentConversation, includeHistoryContext, maxRoundsInput, pendingStartPromptTrigger, retryState, reuseConversationOnManualStart, runEndReason, runStatus, skipPermissions, skipTurnOnNoOutput, startPromptInput, startTurnInput, tasksLoaded, watchDir, watchExtensionsInput, workDir]);

  useEffect(() => {
    if (!tasksLoaded || applyingTaskRef.current) {
      return;
    }

    if (!currentTaskIdRef.current) {
      if (!hasTaskPayload()) {
        return;
      }
      const nextSignature = getTaskPayloadSignature(pageStateRef.current);
      if (deletedTaskSignatureRef.current === nextSignature) {
        return;
      }
      deletedTaskSignatureRef.current = null;
      ensureCurrentTask();
      return;
    }

    persistCurrentTaskSource();
  }, [excludeThought, filePath, queue, rawContent, selectedRoles, tasksLoaded]);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!tasksLoaded || applyingTaskRef.current) {
        return;
      }
      persistCurrentTask();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [tasksLoaded]);

  useEffect(() => {
    window.__REBUILDCHAT_TEST_API__ = {
      clearPersistedTasks,
      flushPersistedTasks,
      resumePersistedTask: async (index: number) => {
        const task = persistedTasksRef.current[index];
        if (task) {
          await handleResumeTask(task);
        }
      },
      seedPromptFile: seedPromptFileForTestApi,
      setRunConfig: setRunConfigForTestApi,
      getState: () => ({
        conversationId,
        conversationResetEveryNRoundsInput,
        currentConversationRoundCount,
        currentTurnIndex,
        currentTaskId,
        effectiveMaxRounds,
        executionErrorRetryCountInput,
        executionTimeoutMinutesInput,
        hasSentStartPromptInCurrentConversation,
        persistedCurrentTurnIndex: getPersistedCurrentTurnIndex(),
        persistedTaskCount: persistedTasksRef.current.length,
        queueLength: queueRef.current.length,
        retryAttemptCount: retryState?.retryAttemptCount ?? null,
        retryAt: retryState?.retryAt ?? null,
        reuseConversationOnManualStart,
        runEndReason,
        runLogCount: runLogs.length,
        loadedRunLogCount: runLogs.length,
        runStatus,
        skipTurnOnNoOutput,
        startPromptInput,
        startPromptRecordCount: startPromptRecords.length,
        loadedStartPromptRecordCount: startPromptRecords.length,
        startTurnInput,
        taskNotice,
        turnRecordCount: turnRecords.length,
        loadedTurnRecordCount: turnRecords.length,
        watchDir,
        workDir,
      }),
    };

    return () => {
      delete window.__REBUILDCHAT_TEST_API__;
    };
    // eslint-disable-next-line max-len
  }, [conversationId, conversationResetEveryNRoundsInput, currentConversationRoundCount, currentTurnIndex, currentTaskId, effectiveMaxRounds, executionErrorRetryCountInput, executionTimeoutMinutesInput, hasSentStartPromptInCurrentConversation, retryState?.retryAttemptCount, retryState?.retryAt, reuseConversationOnManualStart, runEndReason, runLogs.length, runStatus, skipTurnOnNoOutput, startPromptInput, startPromptRecords.length, startTurnInput, taskNotice, turnRecords.length, watchDir, workDir]);

  const syncStartPromptConversationState = (sent: boolean, trigger: RebuildChatStartPromptTrigger | null) => {
    pageStateRef.current.hasSentStartPromptInCurrentConversation = sent;
    pageStateRef.current.pendingStartPromptTrigger = trigger;
    setHasSentStartPromptInCurrentConversation(sent);
    setPendingStartPromptTrigger(trigger);
  };

  const appendStartPromptHistory = (record: StartPromptRecord) => {
    const nextTotalCount = historyStateRef.current.startPromptRecordTotalCount + 1;
    const nextRecords = takeLastEntries([...pageStateRef.current.startPromptRecords, record], historyStateRef.current.startPromptRecordVisibleCount);
    pageStateRef.current.startPromptRecords = nextRecords;
    historyStateRef.current.startPromptRecordTotalCount = nextTotalCount;
    setStartPromptRecords(nextRecords);
    setStartPromptRecordTotalCount(nextTotalCount);
    const taskId = ensureCurrentTask();
    if (taskId) {
      queueTaskHistoryAppend('startPromptRecords', taskId, record);
    }
    persistCurrentTask({
      progress: {
        conversationId: record.conversationId,
        hasSentStartPromptInCurrentConversation: record.status === 'completed',
        pendingStartPromptTrigger: record.status === 'completed' ? null : record.trigger,
        startPromptRecordCount: nextTotalCount,
        retryState: null,
      },
    });
  };

  const runAgyExecutionWithTimeout: RunAgyExecutionWithTimeout = async (phase, phaseLabel, startExecution, initialConversationId, timeoutMinutes) => {
    currentExecutionPhaseRef.current = phase;
    const timeoutMs = typeof window !== 'undefined' && typeof window.__REBUILDCHAT_TIMEOUT_OVERRIDE_MS__ === 'number' ? window.__REBUILDCHAT_TIMEOUT_OVERRIDE_MS__ : getExecutionTimeoutMs(timeoutMinutes);
    let effectiveConversationId = initialConversationId;

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      currentExecutionTimeoutRetryCountRef.current = attempt - 1;
      const attemptConversationId = effectiveConversationId;
      const execution = await startExecution(attemptConversationId);
      currentExecutionRef.current = execution;

      let timeoutHandle: number | null = null;
      const outcome = await Promise.race([
        execution.promise.then((result) => ({ type: 'result' as const, result })),
        new Promise<{ type: 'timeout' }>((resolve) => {
          timeoutHandle = window.setTimeout(() => {
            resolve({ type: 'timeout' });
          }, timeoutMs);
        }),
      ]);

      if (timeoutHandle !== null) {
        window.clearTimeout(timeoutHandle);
      }

      if (outcome.type === 'timeout') {
        try {
          await execution.abort();
        } catch (error) {
          appendRunLog('system', `超时后中止 ${phaseLabel} 时出错：${getRebuildChatRuntimeDriver().formatRuntimeError(error)}`);
        }
        const timeoutResult = await execution.promise.catch((): AgyTurnResult | null => null);
        currentExecutionRef.current = null;
        if (timeoutResult?.conversationId && attemptConversationId !== null) {
          effectiveConversationId = timeoutResult.conversationId;
          pageStateRef.current.conversationId = timeoutResult.conversationId;
          setConversationId(timeoutResult.conversationId);
        }

        if (attempt === 1) {
          appendRunLog('system', `${phaseLabel}已超过 ${timeoutMinutes} 分钟，马上自动重试一次。`);
          continue;
        }

        appendRunLog('system', `${phaseLabel}连续两次超过 ${timeoutMinutes} 分钟，已自动暂停任务。`);
        currentExecutionTimeoutRetryCountRef.current = 0;
        return {
          attempts: attempt,
          conversationId: effectiveConversationId,
          status: 'paused_timeout',
        };
      }

      currentExecutionRef.current = null;
      currentExecutionTimeoutRetryCountRef.current = 0;
      if (outcome.result.conversationId) {
        effectiveConversationId = outcome.result.conversationId;
      }

      return {
        attempts: attempt,
        conversationId: effectiveConversationId,
        result: outcome.result,
        status: 'completed',
      };
    }

    currentExecutionTimeoutRetryCountRef.current = 0;
    return {
      attempts: 2,
      conversationId: effectiveConversationId,
      status: 'paused_timeout',
    };
  };

  const getExecutionOutputLabel = (phase: RebuildChatRetryPhase, phaseLabel: string) => {
    return phase === 'start_prompt' ? '起始 prompt 输出' : `${phaseLabel}输出`;
  };

  const runAgyExecutionWithRecovery: RunAgyExecutionWithRecovery = async (phase, phaseLabel, startExecution, initialConversationId, timeoutMinutes, errorRetryCount) => {
    let effectiveConversationId = initialConversationId;

    for (let attempt = 0; attempt <= errorRetryCount; attempt += 1) {
      const attemptConversationId = effectiveConversationId;
      const timedExecution = await runAgyExecutionWithTimeout(phase, phaseLabel, startExecution, attemptConversationId, timeoutMinutes);
      if (timedExecution.status !== 'completed' || !timedExecution.result) {
        return {
          conversationId: timedExecution.conversationId,
          status: timedExecution.status,
        };
      }

      const executionResult = timedExecution.result;
      const quotaRetry = parseQuotaRetry({
        output: executionResult.output,
        rawLog: executionResult.rawLog,
      });
      const resolvedConversationId = executionResult.conversationId ?? effectiveConversationId;
      const shouldRetryAsError = !abortRequestedRef.current && executionResult.exitCode !== null && executionResult.exitCode !== 0 && !quotaRetry.directive;

      if (!shouldRetryAsError) {
        return {
          conversationId: resolvedConversationId,
          result: executionResult,
          status: 'completed',
        };
      }

      appendRunLog('output', `${getExecutionOutputLabel(phase, phaseLabel)}：${executionResult.output || '(空输出)'}`);
      if (executionResult.conversationId && attemptConversationId !== null) {
        effectiveConversationId = executionResult.conversationId;
        pageStateRef.current.conversationId = executionResult.conversationId;
        setConversationId(executionResult.conversationId);
      } else {
        effectiveConversationId = attemptConversationId;
      }

      if (attempt < errorRetryCount) {
        appendRunLog('system', `${phaseLabel}执行报错，马上进行第 ${attempt + 1} 次重试。`);
        continue;
      }

      appendRunLog('system', `${phaseLabel}已连续报错 ${attempt + 1} 次，已自动暂停任务。`);
      return {
        conversationId: effectiveConversationId,
        status: 'paused_error',
      };
    }

    return {
      conversationId: effectiveConversationId,
      status: 'paused_error',
    };
  };

  const executeQueue = async (startIndex: number, initialConversationId: string | null, effectiveWatchDir: string) => {
    const runtime = getRebuildChatRuntimeDriver();
    const executionErrorRetryCount = resolveExecutionErrorRetryCount();
    if (executionErrorRetryCount === null) {
      return;
    }
    const executionTimeoutMinutes = resolveExecutionTimeoutMinutes();
    if (executionTimeoutMinutes === null) {
      return;
    }
    const conversationResetEveryNRounds = resolveConversationResetInterval();
    if (pageStateRef.current.conversationResetEveryNRoundsInput.trim() && conversationResetEveryNRounds === null) {
      return;
    }

    const runConfig = {
      conversationResetEveryNRounds,
      executionErrorRetryCount,
      executionTimeoutMinutes,
      includeHistoryContext: pageStateRef.current.includeHistoryContext,
      maxRounds: computeEffectiveMaxRounds(pageStateRef.current.maxRoundsInput, queueRef.current.length),
      skipPermissions: pageStateRef.current.skipPermissions,
      startPromptInput: pageStateRef.current.startPromptInput.trim(),
      skipTurnOnNoOutput: pageStateRef.current.skipTurnOnNoOutput,
      watchExtensionsInput: pageStateRef.current.watchExtensionsInput,
      workDir: pageStateRef.current.workDir,
    };
    const emptyFileChanges: {
      created: string[];
      updated: string[];
      deleted: string[];
    } = {
      created: [],
      updated: [],
      deleted: [],
    };
    const hasDetectedFileChanges = (summary: typeof emptyFileChanges) => {
      return summary.created.length > 0 || summary.updated.length > 0 || summary.deleted.length > 0;
    };

    const sendStartPromptIfNeeded = async (options: { conversationId: string | null; targetTurnIndex: number; trigger: RebuildChatStartPromptTrigger }) => {
      if (!runConfig.startPromptInput || pageStateRef.current.hasSentStartPromptInCurrentConversation) {
        return {
          status: 'skipped' as const,
          conversationId: options.conversationId,
        };
      }

      appendRunLog('system', `第 ${options.targetTurnIndex + 1} 轮正文前，先发送起始 prompt（${options.trigger === 'task_start' ? '任务开始' : '会话重置'}）。`);
      const recoveredExecution = await runAgyExecutionWithRecovery(
        'start_prompt',
        '起始 prompt',
        (conversationId) =>
          runtime.startAgyPrintTurn({
            prompt: runConfig.startPromptInput,
            cwd: runConfig.workDir,
            conversationId,
            skipPermissions: runConfig.skipPermissions,
          }),
        options.conversationId,
        runConfig.executionTimeoutMinutes,
        runConfig.executionErrorRetryCount
      );
      if (recoveredExecution.status !== 'completed' || !recoveredExecution.result) {
        syncStartPromptConversationState(false, options.trigger);
        return {
          status: recoveredExecution.status,
          conversationId: recoveredExecution.conversationId,
        };
      }

      const promptResult = recoveredExecution.result;
      const resolvedConversationId = recoveredExecution.conversationId;
      turnConversationMetaRef.current = {
        conversationId: resolvedConversationId,
        currentConversationRoundCount: pageStateRef.current.currentConversationRoundCount,
      };
      pageStateRef.current.conversationId = resolvedConversationId;
      setConversationId(resolvedConversationId);

      const quotaRetry = parseQuotaRetry({
        output: promptResult.output,
        rawLog: promptResult.rawLog,
      });
      if (quotaRetry.directive) {
        syncStartPromptConversationState(false, options.trigger);
        appendRunLog('output', `起始 prompt 输出：${promptResult.output || '(空输出)'}`);
        persistCurrentTask({
          progress: {
            conversationId: resolvedConversationId,
            hasSentStartPromptInCurrentConversation: false,
            pendingStartPromptTrigger: options.trigger,
          },
        });
        return {
          status: 'waiting_retry' as const,
          conversationId: resolvedConversationId,
          output: promptResult.output,
          retryDirective: quotaRetry.directive,
          exitCode: promptResult.exitCode,
        };
      }

      const status: StartPromptRecord['status'] = abortRequestedRef.current || promptResult.exitCode === null ? 'aborted' : promptResult.exitCode === 0 ? 'completed' : 'failed';
      pageStateRef.current.conversationId = resolvedConversationId;
      syncStartPromptConversationState(status === 'completed', status === 'completed' ? null : options.trigger);
      appendRunLog('output', `起始 prompt 输出：${promptResult.output || '(空输出)'}`);
      appendStartPromptHistory(createStartPromptRecord(options.trigger, options.targetTurnIndex, runConfig.startPromptInput, promptResult.output, status, resolvedConversationId));

      return {
        status,
        conversationId: resolvedConversationId,
        output: promptResult.output,
        exitCode: promptResult.exitCode,
      };
    };

    const resetConversationForRetry = (message: string) => {
      const shouldSendStartPrompt = Boolean(runConfig.startPromptInput);
      pageStateRef.current.conversationId = null;
      pageStateRef.current.currentConversationRoundCount = 0;
      setConversationId(null);
      setCurrentConversationRoundCount(0);
      syncStartPromptConversationState(!shouldSendStartPrompt, shouldSendStartPrompt ? 'conversation_reset' : null);
      turnConversationMetaRef.current = {
        conversationId: null,
        currentConversationRoundCount: 0,
      };
      appendRunLog('system', message);
      persistCurrentTask({
        progress: {
          conversationId: null,
          currentConversationRoundCount: 0,
          hasSentStartPromptInCurrentConversation: !shouldSendStartPrompt,
          pendingStartPromptTrigger: shouldSendStartPrompt ? 'conversation_reset' : null,
        },
      });
    };

    const runTurnAttempt = async (prompt: string, conversationIdForAttempt: string | null, startedNewConversation: boolean): Promise<RebuildChatExecuteTurnResult> => {
      const beforeSnapshot = effectiveWatchDir ? await runtime.snapshotDirectory(effectiveWatchDir, runConfig.watchExtensionsInput) : {};
      const recoveredExecution = await runAgyExecutionWithRecovery(
        'turn',
        `第 ${pageStateRef.current.currentTurnIndex + 1} 轮`,
        (conversationId) =>
          runtime.startAgyPrintTurn({
            prompt,
            cwd: runConfig.workDir,
            conversationId,
            skipPermissions: runConfig.skipPermissions,
          }),
        conversationIdForAttempt,
        runConfig.executionTimeoutMinutes,
        runConfig.executionErrorRetryCount
      );
      if (recoveredExecution.status !== 'completed' || !recoveredExecution.result) {
        return {
          conversationId: recoveredExecution.conversationId,
          exitCode: null,
          fileChanges: emptyFileChanges,
          interruptStatus: 'paused' as const,
          output: '',
          phase: 'turn' as const,
          retryDirective: null,
          skipTurnRecord: true,
          startedNewConversation,
          turnStatusOverride: null,
        };
      }

      const turnResult = recoveredExecution.result;
      const afterSnapshot = effectiveWatchDir ? await runtime.snapshotDirectory(effectiveWatchDir, runConfig.watchExtensionsInput) : {};
      const fileChanges = runtime.compareDirectorySnapshots(beforeSnapshot, afterSnapshot);
      const quotaRetry = parseQuotaRetry({
        output: turnResult.output,
        rawLog: turnResult.rawLog,
      });

      return {
        conversationId: turnResult.conversationId ?? conversationIdForAttempt,
        exitCode: turnResult.exitCode,
        output: turnResult.output,
        fileChanges,
        interruptStatus: null,
        phase: 'turn' as const,
        retryDirective: quotaRetry.directive,
        skipTurnRecord: false,
        startedNewConversation,
        turnStatusOverride: null,
      };
    };

    const result = await executeRebuildChatRun({
      queue: queueRef.current,
      startIndex,
      initialConversationId,
      includeHistoryContext: runConfig.includeHistoryContext,
      maxRounds: runConfig.maxRounds,
      onTurnStart: ({ turnIndex }) => {
        setActiveTurnState('running');
        setCurrentTurnIndex(turnIndex);
        syncStartTurnInputToIndex(turnIndex);
        persistCurrentTask({
          status: 'running',
          progress: {
            currentTurnIndex: turnIndex,
            activeTurnState: 'running',
            retryState: null,
          },
        });
      },
      control: {
        isPauseRequested: () => pauseRequestedRef.current,
        consumePauseRequest: () => {
          if (!pauseRequestedRef.current) return false;
          pauseRequestedRef.current = false;
          return true;
        },
        isAbortRequested: () => abortRequestedRef.current,
      },
      executeTurn: async ({ prompt, conversationId: activeConversationId, turnNumber }) => {
        const shouldResetConversation = shouldResetConversationBeforeTurn({
          conversationId: activeConversationId,
          currentConversationRoundCount: pageStateRef.current.currentConversationRoundCount,
          resetEveryNRounds: runConfig.conversationResetEveryNRounds,
        });
        let effectiveConversationId = shouldResetConversation ? null : activeConversationId;

        if (shouldResetConversation) {
          const resetMessage = `已按配置在第 ${pageStateRef.current.currentTurnIndex + 1} 轮前断开旧会话，准备新开 conversationId。`;
          const shouldSendStartPrompt = Boolean(runConfig.startPromptInput);
          pageStateRef.current.conversationId = null;
          pageStateRef.current.currentConversationRoundCount = 0;
          setConversationId(null);
          setCurrentConversationRoundCount(0);
          syncStartPromptConversationState(!shouldSendStartPrompt, shouldSendStartPrompt ? 'conversation_reset' : null);
          turnConversationMetaRef.current = {
            conversationId: null,
            currentConversationRoundCount: 0,
          };
          appendRunLog('system', resetMessage);
          persistCurrentTask({
            progress: {
              conversationId: null,
              currentConversationRoundCount: 0,
              hasSentStartPromptInCurrentConversation: !shouldSendStartPrompt,
              pendingStartPromptTrigger: shouldSendStartPrompt ? 'conversation_reset' : null,
            },
          });
        }

        if (!pageStateRef.current.hasSentStartPromptInCurrentConversation) {
          const startPromptTrigger = pageStateRef.current.pendingStartPromptTrigger ?? 'task_start';
          const startPromptResult = await sendStartPromptIfNeeded({
            conversationId: effectiveConversationId,
            targetTurnIndex: pageStateRef.current.currentTurnIndex,
            trigger: startPromptTrigger,
          });

          if (startPromptResult.status === 'completed') {
            effectiveConversationId = startPromptResult.conversationId;
          } else if (startPromptResult.status === 'paused_timeout' || startPromptResult.status === 'paused_error') {
            return {
              conversationId: startPromptResult.conversationId,
              exitCode: null,
              fileChanges: emptyFileChanges,
              interruptStatus: 'paused' as const,
              output: '',
              phase: 'start_prompt' as const,
              retryDirective: null,
              skipTurnRecord: true,
              startedNewConversation: shouldResetConversation || !activeConversationId,
              turnStatusOverride: null,
            };
          } else if (startPromptResult.status !== 'skipped') {
            return {
              conversationId: startPromptResult.conversationId,
              exitCode: startPromptResult.exitCode ?? null,
              fileChanges: emptyFileChanges,
              interruptStatus: null,
              output: startPromptResult.output,
              phase: 'start_prompt' as const,
              retryDirective: startPromptResult.status === 'waiting_retry' ? startPromptResult.retryDirective : null,
              skipTurnRecord: true,
              startedNewConversation: shouldResetConversation || !activeConversationId,
              turnStatusOverride: null,
            };
          }
        }

        const firstTurnResult = await runTurnAttempt(prompt, effectiveConversationId, shouldResetConversation || !effectiveConversationId);
        if (firstTurnResult.retryDirective || firstTurnResult.interruptStatus === 'paused' || firstTurnResult.exitCode !== 0 || firstTurnResult.skipTurnRecord || hasDetectedFileChanges(firstTurnResult.fileChanges)) {
          return firstTurnResult;
        }

        resetConversationForRetry(`第 ${turnNumber} 轮未检测到文件产出，准备新开会话重试一次。`);

        let retryConversationId: string | null = null;
        if (!pageStateRef.current.hasSentStartPromptInCurrentConversation) {
          const retryStartPromptResult = await sendStartPromptIfNeeded({
            conversationId: null,
            targetTurnIndex: pageStateRef.current.currentTurnIndex,
            trigger: 'conversation_reset',
          });

          if (retryStartPromptResult.status === 'completed') {
            retryConversationId = retryStartPromptResult.conversationId;
          } else if (retryStartPromptResult.status === 'paused_timeout' || retryStartPromptResult.status === 'paused_error') {
            return {
              conversationId: retryStartPromptResult.conversationId,
              exitCode: null,
              fileChanges: emptyFileChanges,
              interruptStatus: 'paused' as const,
              output: '',
              phase: 'start_prompt' as const,
              retryDirective: null,
              skipTurnRecord: true,
              startedNewConversation: true,
              turnStatusOverride: null,
            };
          } else if (retryStartPromptResult.status !== 'skipped') {
            return {
              conversationId: retryStartPromptResult.conversationId,
              exitCode: retryStartPromptResult.exitCode ?? null,
              fileChanges: emptyFileChanges,
              interruptStatus: null,
              output: retryStartPromptResult.output,
              phase: 'start_prompt' as const,
              retryDirective: retryStartPromptResult.status === 'waiting_retry' ? retryStartPromptResult.retryDirective : null,
              skipTurnRecord: true,
              startedNewConversation: true,
              turnStatusOverride: null,
            };
          }
        }

        const retriedTurnResult = await runTurnAttempt(prompt, retryConversationId, true);
        if (retriedTurnResult.retryDirective || retriedTurnResult.interruptStatus === 'paused' || retriedTurnResult.exitCode !== 0 || retriedTurnResult.skipTurnRecord || hasDetectedFileChanges(retriedTurnResult.fileChanges)) {
          return retriedTurnResult;
        }

        if (runConfig.skipTurnOnNoOutput) {
          appendRunLog('system', `第 ${turnNumber} 轮重试后仍未检测到文件产出，已按配置跳过本轮。`);
          return {
            ...retriedTurnResult,
            turnStatusOverride: 'skipped' as const,
          };
        }

        const retryConversationRoundCount = getNextConversationRoundCount({
          currentConversationId: pageStateRef.current.conversationId,
          currentConversationRoundCount: pageStateRef.current.currentConversationRoundCount,
          resolvedConversationId: retriedTurnResult.conversationId,
          startedNewConversation: true,
        });
        turnConversationMetaRef.current = {
          conversationId: retriedTurnResult.conversationId,
          currentConversationRoundCount: retryConversationRoundCount,
        };
        pageStateRef.current.conversationId = retriedTurnResult.conversationId;
        pageStateRef.current.currentConversationRoundCount = retryConversationRoundCount;
        setConversationId(retriedTurnResult.conversationId);
        setCurrentConversationRoundCount(retryConversationRoundCount);
        appendRunLog('system', `第 ${turnNumber} 轮重试后仍未检测到文件产出，已自动暂停任务。`);
        return {
          conversationId: retriedTurnResult.conversationId,
          exitCode: null,
          fileChanges: emptyFileChanges,
          interruptStatus: 'paused' as const,
          output: retriedTurnResult.output,
          phase: 'turn' as const,
          retryDirective: null,
          skipTurnRecord: true,
          startedNewConversation: true,
          turnStatusOverride: null,
        };
      },
      onConversationId: (nextConversationId) => {
        pageStateRef.current.conversationId = nextConversationId;
        setConversationId(nextConversationId);
      },
      onTurnComplete: ({ conversationId: completedConversationId, result: completedResult }) => {
        const nextConversationRoundCount = getNextConversationRoundCount({
          currentConversationId: pageStateRef.current.conversationId,
          currentConversationRoundCount: pageStateRef.current.currentConversationRoundCount,
          resolvedConversationId: completedConversationId,
          startedNewConversation: completedResult.startedNewConversation,
        });
        turnConversationMetaRef.current = {
          conversationId: completedConversationId,
          currentConversationRoundCount: nextConversationRoundCount,
        };
        pageStateRef.current.conversationId = completedConversationId;
        pageStateRef.current.currentConversationRoundCount = nextConversationRoundCount;
        setConversationId(completedConversationId);
        setCurrentConversationRoundCount(nextConversationRoundCount);
      },
      onCurrentTurnIndex: (turnIndex) => {
        setCurrentTurnIndex(turnIndex);
        syncStartTurnInputToIndex(turnIndex);
      },
      onTurnAdvanced: (turnIndex) => {
        setActiveTurnState('idle');
        syncStartTurnInputToIndex(turnIndex);
        persistCurrentTask({
          progress: {
            conversationId: turnConversationMetaRef.current.conversationId,
            currentConversationRoundCount: turnConversationMetaRef.current.currentConversationRoundCount,
            currentTurnIndex: turnIndex,
            activeTurnState: 'idle',
            retryState: null,
          },
        });
      },
      onLog: appendRunLog,
      onTurnRecord: (record) => {
        const nextRecord = {
          ...record,
          id: `turn-${uuid(12)}`,
        };
        const nextTotalCount = historyStateRef.current.turnRecordTotalCount + 1;
        const nextTurnRecords = takeLastEntries([...pageStateRef.current.turnRecords, nextRecord], historyStateRef.current.turnRecordVisibleCount);
        pageStateRef.current.turnRecords = nextTurnRecords;
        historyStateRef.current.turnRecordTotalCount = nextTotalCount;
        if (record.status === 'completed' || record.status === 'skipped') {
          setActiveTurnState('completed_not_advanced');
        }
        setTurnRecords(nextTurnRecords);
        setTurnRecordTotalCount(nextTotalCount);
        const taskId = ensureCurrentTask();
        if (taskId) {
          queueTaskHistoryAppend('turnRecords', taskId, nextRecord);
        }
        persistCurrentTask({
          progress: {
            conversationId: turnConversationMetaRef.current.conversationId,
            currentConversationRoundCount: turnConversationMetaRef.current.currentConversationRoundCount,
            currentTurnIndex: Math.max(record.turnNumber - 1, 0),
            turnRecordCount: nextTotalCount,
            activeTurnState: record.status === 'completed' || record.status === 'skipped' ? 'completed_not_advanced' : pageStateRef.current.activeTurnState,
            retryState: null,
          },
        });
      },
    });

    if (result.status === 'waiting_retry' && result.retryDirective) {
      const previousAttemptCount = pageStateRef.current.retryState?.retryAttemptCount ?? 0;
      const nextRetryState: RetryState = {
        reason: 'quota',
        phase: result.retryDirective && pageStateRef.current.hasSentStartPromptInCurrentConversation ? 'turn' : 'start_prompt',
        retryAt: result.retryDirective.retryAt,
        retryDelayMs: result.retryDirective.retryDelayMs,
        retryAttemptCount: previousAttemptCount + 1,
        resumeTurnIndex: result.nextTurnIndex,
        lastMatchedMessage: result.retryDirective.matchedText,
        source: result.retryDirective.source,
      };
      const retryLabel = getRetryPhaseLabel(nextRetryState.phase);
      const retryMessage = result.retryDirective.retryAt === null ? `${retryLabel}命中额度限制，将按固定间隔 ${formatRetryDelay(result.retryDirective.retryDelayMs)} 自动重试。` : `${retryLabel}命中额度限制，将在 ${formatRetryClock(result.retryDirective.retryAt)} 后自动重试，剩余约 ${formatRetryRemaining(result.retryDirective.retryAt, Date.now())}。`;

      retryAutoResumeRef.current = true;
      clearRetryTimeout();
      currentExecutionRef.current = null;
      setRetryState(nextRetryState);
      setRunStatus('waiting_retry');
      setRunEndReason(null);
      setCurrentTurnIndex(result.nextTurnIndex);
      syncStartTurnInputToIndex(result.nextTurnIndex);
      setActiveTurnState('idle');
      appendRunLog('system', retryMessage);
      persistCurrentTask({
        status: 'waiting_retry',
        progress: {
          conversationId: pageStateRef.current.conversationId,
          currentConversationRoundCount: pageStateRef.current.currentConversationRoundCount,
          currentTurnIndex: result.nextTurnIndex,
          hasSentStartPromptInCurrentConversation: pageStateRef.current.hasSentStartPromptInCurrentConversation,
          pendingStartPromptTrigger: pageStateRef.current.pendingStartPromptTrigger,
          runEndReason: null,
          activeTurnState: 'idle',
          retryState: nextRetryState,
        },
      });
      return;
    }

    finishRun(result.status, result.endReason, result.nextTurnIndex);
  };

  const checkPathExists = async (targetPath: string): Promise<boolean> => {
    if (!targetPath) return false;

    try {
      await ipcBridge.fs.getFileMetadata.invoke({ path: targetPath });
      return true;
    } catch {
      return false;
    }
  };

  const resolveExecutionEnvironment = async (nextWorkDir: string, nextWatchDir: string) => {
    if (!nextWorkDir) {
      Message.warning('请先选择 agy 工作目录。');
      return { canRun: false, effectiveWatchDir: '' };
    }

    if (!(await checkPathExists(nextWorkDir))) {
      const message = '当前 agy 工作目录不存在，请先修正目录后再继续。';
      setTaskNotice(message);
      Message.warning(message);
      return { canRun: false, effectiveWatchDir: '' };
    }

    if (!nextWatchDir) {
      return { canRun: true, effectiveWatchDir: '' };
    }

    if (!(await checkPathExists(nextWatchDir))) {
      const message = '当前监控目录不存在，本次会按空快照继续运行。';
      setTaskNotice(message);
      Message.warning(message);
      return { canRun: true, effectiveWatchDir: '' };
    }

    return { canRun: true, effectiveWatchDir: nextWatchDir };
  };

  const startRunWithFreshTask = (params: StartRunWithFreshTaskParams) => {
    const baseTask = persistedTasksRef.current.find((task) => task.taskId === currentTaskIdRef.current) ?? null;
    const shouldForkTask = Boolean(params.forceFork || (baseTask && baseTask.status !== 'idle'));
    const nextTaskId = shouldForkTask || !currentTaskIdRef.current ? uuid() : currentTaskIdRef.current;
    const createdAt = shouldForkTask || !baseTask ? Date.now() : baseTask.createdAt;

    currentTaskIdRef.current = nextTaskId;
    setCurrentTaskId(nextTaskId);
    currentExecutionPhaseRef.current = 'turn';
    currentExecutionTimeoutRetryCountRef.current = 0;
    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    retryAutoResumeRef.current = false;
    clearRetryTimeout();
    const shouldSendStartPrompt = Boolean(pageStateRef.current.startPromptInput.trim()) && !params.initialConversationId;
    const initialStartPromptTrigger = shouldSendStartPrompt ? 'task_start' : null;
    setRunLogs(params.seedLogs);
    setStartPromptRecords([]);
    setTurnRecords([]);
    setRunLogTotalCount(params.seedLogs.length);
    setStartPromptRecordTotalCount(0);
    setTurnRecordTotalCount(0);
    setRunLogVisibleCount(DEFAULT_HISTORY_PAGE_SIZE);
    setStartPromptRecordVisibleCount(DEFAULT_HISTORY_PAGE_SIZE);
    setTurnRecordVisibleCount(DEFAULT_HISTORY_PAGE_SIZE);
    setConversationId(params.initialConversationId);
    setCurrentConversationRoundCount(params.initialConversationRoundCount ?? 0);
    syncStartPromptConversationState(!shouldSendStartPrompt, initialStartPromptTrigger);
    turnConversationMetaRef.current = {
      conversationId: params.initialConversationId,
      currentConversationRoundCount: params.initialConversationRoundCount ?? 0,
    };
    setCurrentTurnIndex(params.startIndex);
    syncStartTurnInputToIndex(params.startIndex);
    setRunEndReason(null);
    setRunStatus('running');
    setActiveTurnState('idle');
    setRetryState(null);
    setTaskNotice('');
    pageStateRef.current.conversationId = params.initialConversationId;
    pageStateRef.current.currentConversationRoundCount = params.initialConversationRoundCount ?? 0;
    pageStateRef.current.currentTurnIndex = params.startIndex;
    pageStateRef.current.runLogs = params.seedLogs;
    pageStateRef.current.startPromptRecords = [];
    pageStateRef.current.turnRecords = [];
    historyStateRef.current = {
      runLogTotalCount: params.seedLogs.length,
      startPromptRecordTotalCount: 0,
      turnRecordTotalCount: 0,
      runLogVisibleCount: DEFAULT_HISTORY_PAGE_SIZE,
      startPromptRecordVisibleCount: DEFAULT_HISTORY_PAGE_SIZE,
      turnRecordVisibleCount: DEFAULT_HISTORY_PAGE_SIZE,
    };

    const nextTaskMeta = buildPersistedTaskMeta(nextTaskId, createdAt, {
      status: 'running',
      reuseConversationOnManualStart: typeof params.reuseConversationOnManualStartValue === 'boolean' ? params.reuseConversationOnManualStartValue : pageStateRef.current.reuseConversationOnManualStart,
      startTurnInput: params.startTurnInputValue ?? getStartTurnInputValue(params.startIndex, queueRef.current.length),
      progress: {
        conversationId: params.initialConversationId,
        currentConversationRoundCount: params.initialConversationRoundCount ?? 0,
        currentTurnIndex: params.startIndex,
        effectiveMaxRounds: computeEffectiveMaxRounds(pageStateRef.current.maxRoundsInput, queueRef.current.length),
        hasSentStartPromptInCurrentConversation: !shouldSendStartPrompt,
        pendingStartPromptTrigger: initialStartPromptTrigger,
        runEndReason: null,
        runLogCount: params.seedLogs.length,
        startPromptRecordCount: 0,
        turnRecordCount: 0,
        activeTurnState: 'idle',
        retryState: null,
      },
    });
    queueTaskSourceWrite(nextTaskId, buildPersistedTaskSourceSnapshot(nextTaskId, createdAt));
    for (const entry of params.seedLogs) {
      queueTaskHistoryAppend('runLogs', nextTaskId, entry);
    }
    queueTaskMetaWrite(nextTaskMeta);
    void executeQueue(params.startIndex, params.initialConversationId, params.effectiveWatchDir);
  };

  const resumeExecution = (startIndex: number, initialConversationId: string | null, effectiveWatchDir: string, logText: string) => {
    currentExecutionPhaseRef.current = 'turn';
    currentExecutionTimeoutRetryCountRef.current = 0;
    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    retryAutoResumeRef.current = false;
    clearRetryTimeout();
    setTaskNotice('');
    setCurrentTurnIndex(startIndex);
    syncStartTurnInputToIndex(startIndex);
    turnConversationMetaRef.current = {
      conversationId: initialConversationId,
      currentConversationRoundCount: pageStateRef.current.currentConversationRoundCount,
    };
    setActiveTurnState('idle');
    setRunEndReason(null);
    setRunStatus('running');
    setRetryState(null);
    pageStateRef.current.currentTurnIndex = startIndex;
    persistCurrentTask({
      status: 'running',
      progress: {
        currentTurnIndex: startIndex,
        hasSentStartPromptInCurrentConversation: pageStateRef.current.hasSentStartPromptInCurrentConversation,
        pendingStartPromptTrigger: pageStateRef.current.pendingStartPromptTrigger,
        runEndReason: null,
        activeTurnState: 'idle',
        retryState: null,
      },
    });
    appendRunLog('system', logText);
    void executeQueue(startIndex, initialConversationId, effectiveWatchDir);
  };

  const applyPersistedTask = (preview: RebuildChatPersistedTaskPreview, resumeMode: boolean = false) => {
    const { meta, task } = preview;
    applyingTaskRef.current = true;
    queueRebuildSuppressedRef.current = 3;
    currentExecutionPhaseRef.current = 'turn';
    currentExecutionTimeoutRetryCountRef.current = 0;
    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    retryAutoResumeRef.current = false;
    clearRetryTimeout();
    currentExecutionRef.current = null;
    currentTaskIdRef.current = task.taskId;
    queueRef.current = task.queueSnapshot.map((item) => ({ ...item }));

    setCurrentTaskId(task.taskId);
    setFilePath(task.source.filePath);
    setRawContent(task.source.rawContent);
    setExcludeThought(task.source.excludeThought);
    setSelectedRoles(task.source.selectedRoles);
    setQueue(task.queueSnapshot.map((item) => ({ ...item })));
    setSelectedQueueIds([]);
    setErrorText('');
    setWorkDir(task.workDir);
    setWatchDir(task.watchDir);
    setWatchExtensionsInput(task.watchExtensionsInput);
    setMaxRoundsInput(task.maxRoundsInput);
    setExecutionErrorRetryCountInput(task.executionErrorRetryCountInput);
    setExecutionTimeoutMinutesInput(task.executionTimeoutMinutesInput);
    setConversationResetEveryNRoundsInput(task.conversationResetEveryNRoundsInput);
    setStartPromptInput(task.startPromptInput);
    setStartTurnInput(task.startTurnInput);
    setIncludeHistoryContext(task.includeHistoryContext);
    setSkipTurnOnNoOutput(task.skipTurnOnNoOutput);
    setSkipPermissions(task.skipPermissions);
    setReuseConversationOnManualStart(task.reuseConversationOnManualStart);
    setConversationId(task.progress.conversationId);
    setCurrentConversationRoundCount(task.progress.currentConversationRoundCount);
    setHasSentStartPromptInCurrentConversation(task.progress.hasSentStartPromptInCurrentConversation);
    setPendingStartPromptTrigger(task.progress.pendingStartPromptTrigger);
    turnConversationMetaRef.current = {
      conversationId: task.progress.conversationId,
      currentConversationRoundCount: task.progress.currentConversationRoundCount,
    };
    setCurrentTurnIndex(task.progress.currentTurnIndex);
    setRunEndReason(task.progress.runEndReason);
    setRunLogs(task.progress.runLogs.map((entry) => ({ ...entry })));
    setStartPromptRecords(task.progress.startPromptRecords.map((record) => ({ ...record })));
    setTurnRecords(task.progress.turnRecords.map((record) => ({ ...record })));
    setRunLogTotalCount(meta.progress.runLogCount);
    setStartPromptRecordTotalCount(meta.progress.startPromptRecordCount);
    setTurnRecordTotalCount(meta.progress.turnRecordCount);
    setRunLogVisibleCount(Math.max(task.progress.runLogs.length, DEFAULT_HISTORY_PAGE_SIZE));
    setStartPromptRecordVisibleCount(Math.max(task.progress.startPromptRecords.length, DEFAULT_HISTORY_PAGE_SIZE));
    setTurnRecordVisibleCount(Math.max(task.progress.turnRecords.length, DEFAULT_HISTORY_PAGE_SIZE));
    setHistoryLoadingState({
      runLogs: false,
      startPromptRecords: false,
      turnRecords: false,
    });
    historyStateRef.current = {
      runLogTotalCount: meta.progress.runLogCount,
      startPromptRecordTotalCount: meta.progress.startPromptRecordCount,
      turnRecordTotalCount: meta.progress.turnRecordCount,
      runLogVisibleCount: Math.max(task.progress.runLogs.length, DEFAULT_HISTORY_PAGE_SIZE),
      startPromptRecordVisibleCount: Math.max(task.progress.startPromptRecords.length, DEFAULT_HISTORY_PAGE_SIZE),
      turnRecordVisibleCount: Math.max(task.progress.turnRecords.length, DEFAULT_HISTORY_PAGE_SIZE),
    };
    setRetryState(task.progress.retryState ? { ...task.progress.retryState } : null);
    setRunStatus(normalizeLoadedRunStatus(task));
    setActiveTurnState('idle');

    const notices: string[] = [];
    if (!resumeMode && (task.status === 'running' || task.status === 'stopping')) {
      notices.push('这个任务上次关闭时仍在运行，恢复时会从未确认完成的轮次继续。');
    }
    if (task.status === 'waiting_retry' && task.progress.retryState) {
      notices.push(`这个任务正处于额度等待状态。点击“恢复并继续”会先立即重试${getRetryPhaseLabel(task.progress.retryState.phase)}；若仍受限，则继续等待到 ${formatRetryClock(task.progress.retryState.retryAt)}。`);
    }
    setTaskNotice(notices.join(' '));

    void checkPathExists(task.source.filePath)
      .then((exists) => {
        if (exists) {
          return;
        }

        setTaskNotice((previous) => {
          const sourceNotice = '原始 JSON 文件当前不可用，但你仍然可以按已保存队列继续。';
          return previous ? `${previous} ${sourceNotice}` : sourceNotice;
        });
      })
      .catch(() => {});

    queueMicrotask(() => {
      applyingTaskRef.current = false;
    });
  };

  const loadPersistedTaskDetail = async (taskSummary: RebuildChatPersistedTaskSummary) => {
    const preview = await loadRebuildChatTaskPreview(taskSummary.taskId, {
      runLogs: DEFAULT_HISTORY_PAGE_SIZE,
      startPromptRecords: DEFAULT_HISTORY_PAGE_SIZE,
      turnRecords: DEFAULT_HISTORY_PAGE_SIZE,
    });
    if (!preview) {
      Message.error('这条任务详情已经丢失，无法载入。');
      return null;
    }

    return preview;
  };

  const handleLoadTask = async (taskSummary: RebuildChatPersistedTaskSummary) => {
    const preview = await loadPersistedTaskDetail(taskSummary);
    if (!preview) {
      return;
    }

    applyPersistedTask(preview, false);
    Message.success(`已载入任务：${getTaskTitle(taskSummary)}`);
  };

  const handleResumeTask = async (taskSummary: RebuildChatPersistedTaskSummary) => {
    const preview = await loadPersistedTaskDetail(taskSummary);
    if (!preview) {
      return;
    }

    const { task } = preview;
    applyPersistedTask(preview, true);
    if (resolveExecutionErrorRetryCount(task.executionErrorRetryCountInput) === null) {
      return;
    }
    if (resolveExecutionTimeoutMinutes(task.executionTimeoutMinutesInput) === null) {
      return;
    }
    const conversationResetEveryNRounds = resolveConversationResetInterval(task.conversationResetEveryNRoundsInput);
    if (task.conversationResetEveryNRoundsInput.trim() && conversationResetEveryNRounds === null) {
      return;
    }

    const { canRun, effectiveWatchDir } = await resolveExecutionEnvironment(task.workDir, task.watchDir);
    if (!canRun) {
      return;
    }

    const fallbackIndex = getRebuildChatTaskResumeIndex(task);
    const resolved = resolveRequestedStart(fallbackIndex, task.startTurnInput);
    if (!resolved) {
      return;
    }

    if (resolved.isManualStartOverride) {
      const initialConversationId = resolveManualStartConversationId({
        currentConversationId: task.progress.conversationId,
        fallbackIndex,
        requestedStartIndex: resolved.requestedStartIndex,
        reuseConversationOnManualStart: task.reuseConversationOnManualStart,
      });

      window.setTimeout(() => {
        startRunWithFreshTask({
          startIndex: resolved.requestedStartIndex,
          initialConversationId,
          initialConversationRoundCount: task.reuseConversationOnManualStart && initialConversationId ? task.progress.currentConversationRoundCount : 0,
          effectiveWatchDir,
          forceFork: true,
          reuseConversationOnManualStartValue: task.reuseConversationOnManualStart,
          seedLogs: [createRunLogEntry('system', `用户手动指定从第 ${resolved.requestedTurnNumber} 轮开始运行。`), createRunLogEntry('system', `会话复用：${task.reuseConversationOnManualStart ? '开启' : '关闭'}。`)],
          startTurnInputValue: getStartTurnInputValue(resolved.requestedStartIndex, task.queueSnapshot.length),
        });
      }, 0);
      return;
    }

    appendRunLog('system', `已准备恢复任务，将继续第 ${fallbackIndex + 1} 轮。`);
    window.setTimeout(() => {
      resumeExecution(fallbackIndex, task.progress.conversationId, effectiveWatchDir, `从持久化任务恢复，将从第 ${fallbackIndex + 1} 轮继续运行。`);
    }, 0);
  };

  const handleDeleteTask = async (taskId: string) => {
    const isCurrentTask = currentTaskIdRef.current === taskId;
    if (currentTaskIdRef.current === taskId) {
      deletedTaskSignatureRef.current = getTaskPayloadSignature(pageStateRef.current);
      currentTaskIdRef.current = null;
      setCurrentTaskId(null);
    }

    commitPersistedTaskSummaries(persistedTasksRef.current.filter((task) => task.taskId !== taskId));
    if (isCurrentTask || pendingTaskMetaWriteRef.current?.taskId === taskId || pendingTaskSourceWriteRef.current?.taskId === taskId) {
      pendingTaskMetaWriteRef.current = null;
      pendingTaskSourceWriteRef.current = null;
      pendingTaskRunLogAppendRef.current = pendingTaskRunLogAppendRef.current.filter((item) => item.taskId !== taskId);
      pendingTaskTurnRecordAppendRef.current = pendingTaskTurnRecordAppendRef.current.filter((item) => item.taskId !== taskId);
      pendingTaskStartPromptAppendRef.current = pendingTaskStartPromptAppendRef.current.filter((item) => item.taskId !== taskId);
    }
    saveTasksPromiseRef.current = getTaskWriteBarrier()
      .then(() => deleteRebuildChatTask(taskId))
      .then((writtenTasks) => {
        commitPersistedTaskSummaries(writtenTasks);
      })
      .catch((error) => {
        console.error('[RebuildChat] Failed to delete task:', error);
      });
    await saveTasksPromiseRef.current;
    Message.success('已删除任务记录。');
  };

  useEffect(() => {
    if (runStatus !== 'waiting_retry' || !retryState || !retryAutoResumeRef.current) {
      clearRetryTimeout();
      return;
    }

    const delayMs = Math.max((retryState.retryAt ?? Date.now()) - Date.now(), 0);
    retryTimeoutRef.current = window.setTimeout(() => {
      retryTimeoutRef.current = null;
      void (async () => {
        const activeRetryState = pageStateRef.current.retryState;
        if (!activeRetryState) {
          return;
        }

        const { canRun, effectiveWatchDir } = await resolveExecutionEnvironment(pageStateRef.current.workDir, pageStateRef.current.watchDir);
        if (!canRun) {
          retryAutoResumeRef.current = false;
          clearRetryTimeout();
          setRunStatus('paused');
          setRetryState(null);
          appendRunLog('system', '自动重试前发现运行目录不可用，已切换为暂停状态。');
          persistCurrentTask({
            status: 'paused',
            progress: {
              runEndReason: null,
              activeTurnState: 'idle',
              retryState: null,
            },
          });
          return;
        }

        resumeExecution(activeRetryState.resumeTurnIndex, pageStateRef.current.conversationId, effectiveWatchDir, activeRetryState.phase === 'start_prompt' ? '额度等待结束，重新发送起始 prompt。' : '额度等待结束，重新发送当前轮。');
      })();
    }, delayMs);

    return () => {
      clearRetryTimeout();
    };
  }, [retryState, runStatus]);

  useEffect(() => {
    return () => {
      retryAutoResumeRef.current = false;
      clearRetryTimeout();
    };
  }, []);

  useEffect(() => {
    void ipcBridge.application.updateRebuildChatSnapshot
      .invoke({
        snapshot: {
          taskId: currentTaskId,
          runStatus,
          queueLength: queue.length,
          loadedRunLogCount: runLogs.length,
          loadedTurnRecordCount: turnRecords.length,
          loadedStartPromptRecordCount: startPromptRecords.length,
          retryState: retryState
            ? {
                phase: retryState.phase,
                reason: retryState.reason,
                retryAt: retryState.retryAt,
                retryAttemptCount: retryState.retryAttemptCount,
              }
            : null,
          waitingRetry: runStatus === 'waiting_retry',
        },
      })
      .catch(() => {});
  }, [currentTaskId, queue.length, retryState, runLogs.length, runStatus, startPromptRecords.length, turnRecords.length]);

  const loadOlderHistory = useCallback(async (kind: RebuildChatTaskHistoryKind, loadAll: boolean = false) => {
    const taskId = currentTaskIdRef.current;
    if (!taskId) {
      return;
    }

    const totalCount = kind === 'runLogs' ? historyStateRef.current.runLogTotalCount : kind === 'turnRecords' ? historyStateRef.current.turnRecordTotalCount : historyStateRef.current.startPromptRecordTotalCount;
    const loadedCount = kind === 'runLogs' ? pageStateRef.current.runLogs.length : kind === 'turnRecords' ? pageStateRef.current.turnRecords.length : pageStateRef.current.startPromptRecords.length;

    if (loadedCount >= totalCount) {
      return;
    }

    const limit = loadAll ? totalCount - loadedCount : DEFAULT_HISTORY_PAGE_SIZE;
    setHistoryLoadingState((previous) => ({
      ...previous,
      [kind]: true,
    }));

    try {
      if (kind === 'runLogs') {
        const slice = await loadRebuildChatTaskHistorySlice(taskId, 'runLogs', loadedCount, limit);
        if (!slice.items.length) {
          return;
        }
        const nextItems = [...slice.items.map((entry) => ({ ...entry })), ...pageStateRef.current.runLogs];
        pageStateRef.current.runLogs = nextItems;
        historyStateRef.current.runLogVisibleCount = nextItems.length;
        setRunLogs(nextItems);
        setRunLogVisibleCount(nextItems.length);
        return;
      }

      if (kind === 'turnRecords') {
        const slice = await loadRebuildChatTaskHistorySlice(taskId, 'turnRecords', loadedCount, limit);
        if (!slice.items.length) {
          return;
        }
        const nextItems = [...slice.items.map((entry) => ({ ...entry })), ...pageStateRef.current.turnRecords];
        pageStateRef.current.turnRecords = nextItems;
        historyStateRef.current.turnRecordVisibleCount = nextItems.length;
        setTurnRecords(nextItems);
        setTurnRecordVisibleCount(nextItems.length);
        return;
      }

      const slice = await loadRebuildChatTaskHistorySlice(taskId, 'startPromptRecords', loadedCount, limit);
      if (!slice.items.length) {
        return;
      }
      const nextItems = [...slice.items.map((entry) => ({ ...entry })), ...pageStateRef.current.startPromptRecords];
      pageStateRef.current.startPromptRecords = nextItems;
      historyStateRef.current.startPromptRecordVisibleCount = nextItems.length;
      setStartPromptRecords(nextItems);
      setStartPromptRecordVisibleCount(nextItems.length);
    } finally {
      setHistoryLoadingState((previous) => ({
        ...previous,
        [kind]: false,
      }));
    }
  }, []);

  const toggleRole = (role: string) => {
    setSelectedRoles((previous) => (previous.includes(role) ? previous.filter((item) => item !== role) : [...previous, role]));
  };

  const handlePickFile = async () => {
    setLoading(true);
    try {
      if (window.__REBUILDCHAT_FILE_PICKER_OVERRIDE__) {
        const { filePath: nextPath, rawContent: nextContent, workDir: nextWorkDir, watchDir: nextWatchDir } = window.__REBUILDCHAT_FILE_PICKER_OVERRIDE__;
        applyPromptFileSelection(nextPath, nextContent, nextWorkDir, nextWatchDir);
        Message.success('已加载对话文件。');
        return;
      }

      const result = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });

      if (!result?.length) {
        return;
      }

      const nextPath = result[0];
      const nextContent = await ipcBridge.fs.readFile.invoke({ path: nextPath });
      applyPromptFileSelection(nextPath, nextContent, undefined, undefined, true);
      Message.success('已加载对话文件。');
    } catch (error) {
      const message = parseError(error);
      setErrorText(message);
      Message.error(message);
    } finally {
      setLoading(false);
    }
  };

  const handleReload = async () => {
    if (!filePath) return;

    setLoading(true);
    try {
      const nextContent = await ipcBridge.fs.readFile.invoke({ path: filePath });
      setRawContent(nextContent);
      setErrorText('');
      Message.success('已重新读取文件。');
    } catch (error) {
      const message = parseError(error);
      setErrorText(message);
      Message.error(message);
    } finally {
      setLoading(false);
    }
  };

  const pickDirectory = async (onSelect: (value: string) => void) => {
    try {
      const result = await ipcBridge.dialog.showOpen.invoke({
        properties: ['openDirectory'],
      });

      if (!result?.length) {
        return;
      }

      onSelect(result[0]);
    } catch (error) {
      Message.error(parseError(error));
    }
  };

  const toggleQueueSelection = (id: string) => {
    setSelectedQueueIds((previous) => (previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id]));
  };

  const handleDeleteSelected = () => {
    setQueue((previous) => removeEditablePromptQueueItems(previous, selectedQueueIds));
    setSelectedQueueIds([]);
  };

  const handleDeleteSingle = (id: string) => {
    setQueue((previous) => removeEditablePromptQueueItems(previous, [id]));
    setSelectedQueueIds((previous) => previous.filter((item) => item !== id));
  };

  const handleAddCustom = () => {
    const defaultRole = selectedRoles[0] || parseResult?.availableRoles[0] || 'user';
    setQueue((previous) => appendCustomPromptQueueItem(previous, { role: defaultRole }));
  };

  const handleQueueChange = (id: string, updates: { role?: string; text?: string }) => {
    setQueue((previous) => updateEditablePromptQueueItem(previous, id, updates));
  };

  const handleStart = () => {
    void (async () => {
      if (!queue.length) {
        Message.warning('当前没有可发送的队列内容。');
        return;
      }

      if (resolveExecutionTimeoutMinutes() === null) {
        return;
      }
      if (resolveExecutionErrorRetryCount() === null) {
        return;
      }

      const conversationResetEveryNRounds = resolveConversationResetInterval();
      if (pageStateRef.current.conversationResetEveryNRoundsInput.trim() && conversationResetEveryNRounds === null) {
        return;
      }

      const resolved = resolveRequestedStart(0);
      if (!resolved) {
        return;
      }

      const { canRun, effectiveWatchDir } = await resolveExecutionEnvironment(workDir, watchDir);
      if (!canRun) {
        return;
      }

      const initialConversationId = resolveManualStartConversationId({
        currentConversationId: pageStateRef.current.conversationId,
        fallbackIndex: resolved.fallbackIndex,
        requestedStartIndex: resolved.requestedStartIndex,
        reuseConversationOnManualStart: pageStateRef.current.reuseConversationOnManualStart,
      });
      const reuseConversationForManualStart = resolved.isManualStartOverride && pageStateRef.current.reuseConversationOnManualStart && Boolean(initialConversationId);
      const initialConversationRoundCount = reuseConversationForManualStart ? pageStateRef.current.currentConversationRoundCount : 0;
      const seedLogs = resolved.isManualStartOverride ? [createRunLogEntry('system', `用户手动指定从第 ${resolved.requestedTurnNumber} 轮开始运行。`), createRunLogEntry('system', `会话复用：${pageStateRef.current.reuseConversationOnManualStart ? '开启' : '关闭'}。`)] : [createRunLogEntry('system', '开始新一轮运行。')];

      startRunWithFreshTask({
        startIndex: resolved.requestedStartIndex,
        initialConversationId: resolved.isManualStartOverride ? initialConversationId : null,
        initialConversationRoundCount,
        effectiveWatchDir,
        forceFork: resolved.isManualStartOverride,
        reuseConversationOnManualStartValue: pageStateRef.current.reuseConversationOnManualStart,
        seedLogs,
        startTurnInputValue: getStartTurnInputValue(resolved.requestedStartIndex, queueRef.current.length),
      });
    })();
  };

  const handlePause = () => {
    if (runStatus !== 'running') return;
    pauseRequestedRef.current = true;
    setRunStatus('stopping');
    persistCurrentTask({ status: 'stopping' });
    appendRunLog('system', '已请求暂停，将在当前轮完成后停下。');
  };

  const handleResume = () => {
    void (async () => {
      if (runStatus !== 'paused') return;
      if (resolveExecutionErrorRetryCount() === null) {
        return;
      }
      if (resolveExecutionTimeoutMinutes() === null) {
        return;
      }
      const conversationResetEveryNRounds = resolveConversationResetInterval();
      if (pageStateRef.current.conversationResetEveryNRoundsInput.trim() && conversationResetEveryNRounds === null) {
        return;
      }

      const resolved = resolveRequestedStart(currentTurnIndex);
      if (!resolved) {
        return;
      }

      const { canRun, effectiveWatchDir } = await resolveExecutionEnvironment(workDir, watchDir);
      if (!canRun) {
        return;
      }

      if (resolved.isManualStartOverride) {
        const initialConversationId = resolveManualStartConversationId({
          currentConversationId: conversationId,
          fallbackIndex: resolved.fallbackIndex,
          requestedStartIndex: resolved.requestedStartIndex,
          reuseConversationOnManualStart,
        });

        startRunWithFreshTask({
          startIndex: resolved.requestedStartIndex,
          initialConversationId,
          initialConversationRoundCount: reuseConversationOnManualStart && initialConversationId ? currentConversationRoundCount : 0,
          effectiveWatchDir,
          forceFork: true,
          reuseConversationOnManualStartValue: reuseConversationOnManualStart,
          seedLogs: [createRunLogEntry('system', `用户手动指定从第 ${resolved.requestedTurnNumber} 轮开始运行。`), createRunLogEntry('system', `会话复用：${reuseConversationOnManualStart ? '开启' : '关闭'}。`)],
          startTurnInputValue: getStartTurnInputValue(resolved.requestedStartIndex, queueRef.current.length),
        });
        return;
      }

      resumeExecution(currentTurnIndex, conversationId, effectiveWatchDir, `从第 ${currentTurnIndex + 1} 轮继续运行。`);
    })();
  };

  const handleAbort = async () => {
    if (runStatus === 'paused') {
      appendRunLog('system', '已在暂停状态下中止本次运行。');
      finishRun('completed', 'aborted', currentTurnIndex);
      return;
    }

    if (runStatus === 'waiting_retry') {
      appendRunLog('system', '已取消额度等待并中止本次运行。');
      finishRun('completed', 'aborted', currentTurnIndex);
      return;
    }

    if (runStatus !== 'running' && runStatus !== 'stopping') return;

    abortRequestedRef.current = true;
    setRunStatus('stopping');
    persistCurrentTask({ status: 'stopping' });
    appendRunLog('system', '正在中止当前运行。');
    try {
      await currentExecutionRef.current?.abort();
    } catch (error) {
      appendRunLog('system', `中止进程时出错：${getRebuildChatRuntimeDriver().formatRuntimeError(error)}`);
    }
  };

  const primaryActionFallbackIndex = runStatus === 'paused' ? currentTurnIndex : 0;
  const primaryActionLabel = runStatus === 'paused' ? '继续' : '开始';
  const startTurnPreviewText = useMemo(() => {
    if (!queue.length) {
      return '';
    }

    const resolved = resolveRequestedStartIndex({
      fallbackIndex: primaryActionFallbackIndex,
      queueLength: queue.length,
      startTurnInput,
    });

    if (!resolved.ok || !resolved.isManualStartOverride) {
      return '';
    }

    return `本次点击“${primaryActionLabel}”将从第 ${resolved.requestedTurnNumber} 轮启动。`;
  }, [currentTurnIndex, primaryActionFallbackIndex, primaryActionLabel, queue.length, runStatus, startTurnInput]);

  const conversationResetPreviewText = useMemo(() => {
    const parsed = parseConversationResetEveryNRounds(conversationResetEveryNRoundsInput);
    if (parsed.error || parsed.value === null) {
      return '';
    }

    return `会话策略：每 ${parsed.value} 轮自动断开旧 conversationId，当前会话已累计 ${currentConversationRoundCount} 轮。`;
  }, [conversationResetEveryNRoundsInput, currentConversationRoundCount]);

  return (
    <div className={styles.page} data-testid='rebuildchat-page'>
      <div className={styles.shell}>
        <TopStatusBar runStatus={runStatus} runEndReason={runEndReason} nextTurnNumber={Math.min(currentTurnIndex + 1, Math.max(queue.length, 1))} conversationId={conversationId} effectiveMaxRounds={effectiveMaxRounds} startDisabled={runStatus === 'running' || runStatus === 'stopping' || runStatus === 'waiting_retry' || !queue.length} pauseDisabled={runStatus !== 'running'} resumeDisabled={runStatus !== 'paused'} abortDisabled={runStatus !== 'running' && runStatus !== 'stopping' && runStatus !== 'paused' && runStatus !== 'waiting_retry'} onStart={handleStart} onPause={handlePause} onResume={handleResume} onAbort={() => void handleAbort()} onOpenConfig={() => setConfigDrawerVisible(true)} />

        {runStatus === 'waiting_retry' && retryState ? <RetryCountdownNotice currentTurnIndex={currentTurnIndex} retryState={retryState} /> : null}

        <div className={styles.workspace}>
          <div className={styles.column}>
            <TaskListPanel taskNotice={taskNotice} persistedTasks={persistedTasks} onResumeTask={(task) => void handleResumeTask(task)} onLoadTask={(task) => void handleLoadTask(task)} onDeleteTask={(taskId) => void handleDeleteTask(taskId)} />
            <InputPanel filePath={filePath} loading={loading} disabled={isRunLocked} errorText={errorText} excludeThought={excludeThought} onExcludeThoughtChange={(checked) => setExcludeThought(checked)} parseResult={parseResult} selectedRoles={selectedRoles} onToggleRole={toggleRole} onPickFile={handlePickFile} onReload={handleReload} />
            <ParseSummaryPanel totalChunks={parseResult?.totalChunks ?? 0} filteredOutThoughts={parseResult?.filteredOutThoughts ?? 0} skippedInvalidChunks={parseResult?.skippedInvalidChunks ?? 0} validChunkCount={filteredChunks.length} />
          </div>

          <div className={styles.column}>
            <QueueEditorPanel queue={queue} selectedQueueIds={selectedQueueIds} disabled={isRunLocked} hasParseResult={Boolean(parseResult)} stats={queueStats} onToggleSelection={toggleQueueSelection} onDeleteSelected={handleDeleteSelected} onDeleteSingle={handleDeleteSingle} onAddCustom={handleAddCustom} onQueueChange={handleQueueChange} />
          </div>

          <div className={styles.column}>
            <RunLogPanel runLogs={runLogs} totalCount={runLogTotalCount} loading={historyLoadingState.runLogs} conversationResetPreviewText={conversationResetPreviewText} startTurnPreviewText={startTurnPreviewText} onLoadOlder={(loadAll) => void loadOlderHistory('runLogs', loadAll)} />
            <ObservePanel startPromptRecords={displayedStartPromptRecords} startPromptLoadedCount={startPromptRecords.length} startPromptTotalCount={startPromptRecordTotalCount} turnRecords={displayedTurnRecords} turnLoadedCount={turnRecords.length} turnTotalCount={turnRecordTotalCount} startPromptLoading={historyLoadingState.startPromptRecords} turnRecordLoading={historyLoadingState.turnRecords} onLoadOlderStartPrompts={(loadAll) => void loadOlderHistory('startPromptRecords', loadAll)} onLoadOlderTurnRecords={(loadAll) => void loadOlderHistory('turnRecords', loadAll)} />
          </div>
        </div>

        <RunConfigDrawer
          visible={configDrawerVisible}
          onClose={() => setConfigDrawerVisible(false)}
          disabled={isRunLocked}
          workDir={workDir}
          onWorkDirChange={setWorkDir}
          watchDir={watchDir}
          onWatchDirChange={setWatchDir}
          onPickDirectory={pickDirectory}
          watchExtensionsInput={watchExtensionsInput}
          onWatchExtensionsInputChange={setWatchExtensionsInput}
          maxRoundsInput={maxRoundsInput}
          onMaxRoundsInputChange={setMaxRoundsInput}
          executionTimeoutMinutesInput={executionTimeoutMinutesInput}
          onExecutionTimeoutMinutesInputChange={setExecutionTimeoutMinutesInput}
          executionErrorRetryCountInput={executionErrorRetryCountInput}
          onExecutionErrorRetryCountInputChange={setExecutionErrorRetryCountInput}
          conversationResetEveryNRoundsInput={conversationResetEveryNRoundsInput}
          onConversationResetEveryNRoundsInputChange={setConversationResetEveryNRoundsInput}
          startTurnInput={startTurnInput}
          onStartTurnInputChange={setStartTurnInput}
          startPromptInput={startPromptInput}
          onStartPromptInputChange={setStartPromptInput}
          includeHistoryContext={includeHistoryContext}
          onIncludeHistoryContextChange={(checked) => setIncludeHistoryContext(checked)}
          skipTurnOnNoOutput={skipTurnOnNoOutput}
          onSkipTurnOnNoOutputChange={(checked) => setSkipTurnOnNoOutput(checked)}
          reuseConversationOnManualStart={reuseConversationOnManualStart}
          onReuseConversationOnManualStartChange={(checked) => setReuseConversationOnManualStart(checked)}
          skipPermissions={skipPermissions}
          onSkipPermissionsChange={(checked) => setSkipPermissions(checked)}
        />
      </div>
    </div>
  );
};

export default RebuildChatPage;
