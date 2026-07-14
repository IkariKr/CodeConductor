import { ipcBridge } from '@/common';
import { appendCustomPromptQueueItem, createEditablePromptQueue, removeEditablePromptQueueItems, updateEditablePromptQueueItem, type EditablePromptQueueItem } from '@/common/rebuildchat/editablePromptQueue';
import { canResumeRebuildChatTask, getPersistedTaskStatus, getRebuildChatTaskResumeIndex, sortRebuildChatTasks, type RebuildChatActiveTurnState, type RebuildChatPersistedLogEntry, type RebuildChatPersistedRetryState, type RebuildChatPersistedTask, type RebuildChatPersistedTaskStatus, type RebuildChatPersistedTurnRecord } from '@/common/rebuildchat/persistedTask';
import { parsePromptFile, type ParsePromptFileResult } from '@/common/rebuildchat/promptFileParser';
import { executeRebuildChatRun, summarizeFileChanges, type RunEndReason, type RunLogKind, type RunStatus } from '@/common/rebuildchat/rebuildChatExecutor';
import { parseQuotaRetry } from '@/common/rebuildchat/quotaRetryParser';
import { parseError, uuid } from '@/common/utils';
import { Button, Card, Checkbox, Empty, Input, Message, Space, Switch, Tag, Typography } from '@arco-design/web-react';
import { CloseOne, Delete, Pause, Play, Plus, Refresh, Right, UploadOne } from '@icon-park/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getRebuildChatRuntimeDriver } from './runtime';
import styles from './index.module.css';
import { loadRebuildChatTasks, saveRebuildChatTasks } from './taskStorage';

const { Paragraph, Text } = Typography;

type RunLogEntry = RebuildChatPersistedLogEntry;
type RetryState = RebuildChatPersistedRetryState;
type TurnRecord = RebuildChatPersistedTurnRecord;
type RebuildChatTaskOverrides = Omit<Partial<RebuildChatPersistedTask>, 'progress' | 'source'> & {
  progress?: Partial<RebuildChatPersistedTask['progress']>;
  source?: Partial<RebuildChatPersistedTask['source']>;
};

interface RebuildChatSeedPromptFilePayload {
  filePath: string;
  rawContent: string;
  watchDir?: string;
  workDir?: string;
}

interface RebuildChatRunConfigPayload {
  includeHistoryContext?: boolean;
  maxRoundsInput?: string;
  skipPermissions?: boolean;
  stopOnNoChanges?: boolean;
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

interface RebuildChatTestApi {
  clearPersistedTasks: () => Promise<void>;
  flushPersistedTasks: () => Promise<void>;
  getState: () => {
    conversationId: string | null;
    currentTurnIndex: number;
    currentTaskId: string | null;
    effectiveMaxRounds: number;
    persistedCurrentTurnIndex: number | null;
    persistedTaskCount: number;
    queueLength: number;
    retryAttemptCount: number | null;
    retryAt: number | null;
    runEndReason: RunEndReason;
    runLogCount: number;
    runStatus: RunStatus;
    taskNotice: string;
    turnRecordCount: number;
    watchDir: string;
    workDir: string;
  };
  resumePersistedTask: (index: number) => Promise<void>;
  seedPromptFile: (payload: RebuildChatSeedPromptFilePayload) => void;
  setRunConfig: (payload: RebuildChatRunConfigPayload) => void;
}

declare global {
  interface Window {
    __REBUILDCHAT_FILE_PICKER_OVERRIDE__?: RebuildChatFilePickerOverride;
    __REBUILDCHAT_TEST_API__?: RebuildChatTestApi;
  }
}

const getEndReasonLabel = (reason: RunEndReason): string => {
  switch (reason) {
    case 'all_sent':
      return '所有条目已发送完成';
    case 'max_rounds':
      return '达到最大轮数';
    case 'no_output':
      return '本轮无文件产出';
    case 'aborted':
      return '人工中止';
    case 'failed':
      return '运行失败';
    default:
      return '尚未结束';
  }
};

const getTaskStatusLabel = (status: RebuildChatPersistedTaskStatus): string => {
  switch (status) {
    case 'running':
      return '运行中';
    case 'paused':
      return '已暂停';
    case 'stopping':
      return '停止中';
    case 'waiting_retry':
      return '等待重试';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'aborted':
      return '已中止';
    default:
      return '草稿';
  }
};

const getTaskTitle = (task: RebuildChatPersistedTask): string => {
  const normalizedPath = task.source.filePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || `任务 ${task.taskId.slice(0, 8)}`;
};

const getTaskProgressLabel = (task: RebuildChatPersistedTask): string => {
  const nextTurn = Math.min(getRebuildChatTaskResumeIndex(task) + 1, Math.max(task.queueSnapshot.length, 1));
  const totalTurns = Math.max(task.progress.effectiveMaxRounds || task.queueSnapshot.length, 0);
  return `第 ${nextTurn} / ${totalTurns}`;
};

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

const computeEffectiveMaxRounds = (maxRoundsValue: string, queueLength: number) => {
  const parsed = Number(maxRoundsValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return queueLength;
  }
  return Math.min(queueLength, Math.floor(parsed));
};

const formatRetryDelay = (delayMs: number): string => {
  const totalSeconds = Math.max(Math.ceil(delayMs / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分钟`);
  if (seconds || !parts.length) parts.push(`${seconds}秒`);

  return parts.join('');
};

const formatRetryClock = (retryAt: number | null): string => {
  if (retryAt === null) {
    return '待定';
  }

  return new Date(retryAt).toLocaleTimeString();
};

const formatRetryRemaining = (retryAt: number | null, now: number): string => {
  if (retryAt === null) {
    return '按固定间隔等待';
  }

  return formatRetryDelay(Math.max(retryAt - now, 0));
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
  const [includeHistoryContext, setIncludeHistoryContext] = useState(false);
  const [stopOnNoChanges, setStopOnNoChanges] = useState(true);
  const [skipPermissions, setSkipPermissions] = useState(false);

  const [runStatus, setRunStatus] = useState<RunStatus>('idle');
  const [runEndReason, setRunEndReason] = useState<RunEndReason>(null);
  const [runLogs, setRunLogs] = useState<RunLogEntry[]>([]);
  const [turnRecords, setTurnRecords] = useState<TurnRecord[]>([]);
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activeTurnState, setActiveTurnState] = useState<RebuildChatActiveTurnState>('idle');
  const [retryState, setRetryState] = useState<RetryState | null>(null);
  const [retryClockNow, setRetryClockNow] = useState(() => Date.now());
  const [persistedTasks, setPersistedTasks] = useState<RebuildChatPersistedTask[]>([]);
  const [tasksLoaded, setTasksLoaded] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [taskNotice, setTaskNotice] = useState('');

  const queueRef = useRef(queue);
  const currentExecutionRef = useRef<Awaited<ReturnType<ReturnType<typeof getRebuildChatRuntimeDriver>['startAgyPrintTurn']>> | null>(null);
  const pauseRequestedRef = useRef(false);
  const abortRequestedRef = useRef(false);
  const queueRebuildSuppressedRef = useRef(0);
  const applyingTaskRef = useRef(false);
  const persistedTasksRef = useRef<RebuildChatPersistedTask[]>([]);
  const currentTaskIdRef = useRef<string | null>(null);
  const retryTimeoutRef = useRef<number | null>(null);
  const retryAutoResumeRef = useRef(false);
  const saveTasksPromiseRef = useRef(Promise.resolve());
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
    includeHistoryContext: false,
    stopOnNoChanges: true,
    skipPermissions: false,
    runStatus: 'idle' as RunStatus,
    runEndReason: null as RunEndReason,
    runLogs: [] as RunLogEntry[],
    turnRecords: [] as TurnRecord[],
    currentTurnIndex: 0,
    conversationId: null as string | null,
    activeTurnState: 'idle' as RebuildChatActiveTurnState,
    retryState: null as RetryState | null,
  });

  const commitPersistedTasks = (tasks: RebuildChatPersistedTask[]) => {
    const nextTasks = sortRebuildChatTasks(tasks);
    persistedTasksRef.current = nextTasks;
    setPersistedTasks(nextTasks);
    saveTasksPromiseRef.current = saveTasksPromiseRef.current
      .then(() => saveRebuildChatTasks(nextTasks))
      .catch((error) => {
        console.error('[RebuildChat] Failed to save tasks:', error);
      });
    return nextTasks;
  };

  const buildPersistedTask = (taskId: string, createdAt: number, overrides: RebuildChatTaskOverrides = {}): RebuildChatPersistedTask => {
    const state = pageStateRef.current;
    const baseTask: RebuildChatPersistedTask = {
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
      stopOnNoChanges: state.stopOnNoChanges,
      skipPermissions: state.skipPermissions,
      progress: {
        conversationId: state.conversationId,
        currentTurnIndex: state.currentTurnIndex,
        effectiveMaxRounds: computeEffectiveMaxRounds(state.maxRoundsInput, state.queue.length),
        runEndReason: state.runEndReason,
        runLogs: state.runLogs.map((entry) => ({ ...entry })),
        turnRecords: state.turnRecords.map((record) => ({ ...record })),
        activeTurnState: state.activeTurnState,
        retryState: state.retryState ? { ...state.retryState } : null,
      },
    };

    return {
      ...baseTask,
      ...overrides,
      source: {
        ...baseTask.source,
        ...(overrides.source || {}),
      },
      progress: {
        ...baseTask.progress,
        ...(overrides.progress || {}),
      },
    };
  };

  const hasTaskPayload = () => {
    const state = pageStateRef.current;
    return Boolean(state.filePath || state.rawContent || state.queue.length || state.runLogs.length || state.turnRecords.length);
  };

  const ensureCurrentTask = () => {
    if (currentTaskIdRef.current) {
      return currentTaskIdRef.current;
    }

    if (!hasTaskPayload()) {
      return null;
    }

    const taskId = uuid();
    const task = buildPersistedTask(taskId, Date.now());
    commitPersistedTasks([task, ...persistedTasksRef.current.filter((item) => item.taskId !== taskId)]);
    currentTaskIdRef.current = taskId;
    setCurrentTaskId(taskId);
    return taskId;
  };

  const persistCurrentTask = (overrides: RebuildChatTaskOverrides = {}) => {
    const taskId = ensureCurrentTask();
    if (!taskId) {
      return null;
    }

    const existing = persistedTasksRef.current.find((task) => task.taskId === taskId);
    const createdAt = existing?.createdAt ?? Date.now();
    const nextTask = buildPersistedTask(taskId, createdAt, overrides);
    commitPersistedTasks([nextTask, ...persistedTasksRef.current.filter((task) => task.taskId !== taskId)]);
    return nextTask;
  };

  const clearPersistedTasks = async () => {
    currentTaskIdRef.current = null;
    setCurrentTaskId(null);
    commitPersistedTasks([]);
    await saveTasksPromiseRef.current;
  };

  const flushPersistedTasks = async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    if (tasksLoaded && !applyingTaskRef.current) {
      const taskId = currentTaskIdRef.current ?? ensureCurrentTask();
      if (taskId) {
        const createdAt = persistedTasksRef.current.find((task) => task.taskId === taskId)?.createdAt ?? Date.now();
        commitPersistedTasks([
          {
            taskId,
            createdAt,
            updatedAt: Date.now(),
            status: getPersistedTaskStatus(runStatus, runEndReason),
            source: {
              filePath,
              rawContent,
              excludeThought,
              selectedRoles: [...selectedRoles],
            },
            queueSnapshot: queue.map((item) => ({ ...item })),
            workDir,
            watchDir,
            watchExtensionsInput,
            includeHistoryContext,
            maxRoundsInput,
            stopOnNoChanges,
            skipPermissions,
            progress: {
              conversationId,
              currentTurnIndex,
              effectiveMaxRounds,
              runEndReason,
              runLogs: runLogs.map((entry) => ({ ...entry })),
              turnRecords: turnRecords.map((record) => ({ ...record })),
              activeTurnState,
              retryState: retryState ? { ...retryState } : null,
            },
          },
          ...persistedTasksRef.current.filter((task) => task.taskId !== taskId),
        ]);
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
      includeHistoryContext,
      stopOnNoChanges,
      skipPermissions,
      runStatus,
      runEndReason,
      runLogs,
      turnRecords,
      currentTurnIndex,
      conversationId,
      activeTurnState,
      retryState,
    };
    // eslint-disable-next-line max-len
  }, [activeTurnState, conversationId, currentTurnIndex, excludeThought, filePath, includeHistoryContext, maxRoundsInput, queue, rawContent, retryState, runEndReason, runLogs, runStatus, selectedRoles, skipPermissions, stopOnNoChanges, turnRecords, watchDir, watchExtensionsInput, workDir]);

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

  const effectiveMaxRounds = useMemo(() => {
    return computeEffectiveMaxRounds(maxRoundsInput, queue.length);
  }, [maxRoundsInput, queue.length]);

  const isRunLocked = runStatus === 'running' || runStatus === 'stopping' || runStatus === 'waiting_retry';

  const appendRunLog = (kind: RunLogKind, text: string) => {
    setRunLogs((previous) => [...previous, createRunLogEntry(kind, text)]);
  };

  const clearRetryTimeout = () => {
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  };

  const resetRunState = () => {
    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    retryAutoResumeRef.current = false;
    clearRetryTimeout();
    currentExecutionRef.current = null;
    setRunStatus('idle');
    setRunEndReason(null);
    setRunLogs([]);
    setTurnRecords([]);
    setCurrentTurnIndex(0);
    setConversationId(null);
    setActiveTurnState('idle');
    setRetryState(null);
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
    const nextIncludeHistory = payload.includeHistoryContext;
    const nextStopOnNoChanges = payload.stopOnNoChanges;
    const nextSkipPermissions = payload.skipPermissions;

    if (typeof nextWorkDir === 'string') setWorkDir(nextWorkDir);
    if (typeof nextWatchDir === 'string') setWatchDir(nextWatchDir);
    if (typeof nextWatchExtensions === 'string') setWatchExtensionsInput(nextWatchExtensions);
    if (typeof nextMaxRounds === 'string') setMaxRoundsInput(nextMaxRounds);
    if (typeof nextIncludeHistory === 'boolean') setIncludeHistoryContext(nextIncludeHistory);
    if (typeof nextStopOnNoChanges === 'boolean') setStopOnNoChanges(nextStopOnNoChanges);
    if (typeof nextSkipPermissions === 'boolean') setSkipPermissions(nextSkipPermissions);
  };

  const finishRun = (status: RunStatus, reason: RunEndReason, nextTurnIndex?: number) => {
    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    retryAutoResumeRef.current = false;
    clearRetryTimeout();
    currentExecutionRef.current = null;
    setRunStatus(status);
    setRunEndReason(reason);
    setActiveTurnState('idle');
    setRetryState(null);
    if (typeof nextTurnIndex === 'number') {
      setCurrentTurnIndex(nextTurnIndex);
    }
    persistCurrentTask({
      status: getPersistedTaskStatus(status, reason),
      progress: {
        currentTurnIndex: typeof nextTurnIndex === 'number' ? nextTurnIndex : pageStateRef.current.currentTurnIndex,
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
      ensureCurrentTask();
      return;
    }

    persistCurrentTask();
    // eslint-disable-next-line max-len
  }, [activeTurnState, conversationId, currentTurnIndex, excludeThought, filePath, includeHistoryContext, maxRoundsInput, queue, rawContent, retryState, runEndReason, runLogs, runStatus, selectedRoles, skipPermissions, stopOnNoChanges, tasksLoaded, turnRecords, watchDir, watchExtensionsInput, workDir]);

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
        currentTurnIndex,
        currentTaskId,
        effectiveMaxRounds,
        persistedCurrentTurnIndex: getPersistedCurrentTurnIndex(),
        persistedTaskCount: persistedTasksRef.current.length,
        queueLength: queueRef.current.length,
        retryAttemptCount: retryState?.retryAttemptCount ?? null,
        retryAt: retryState?.retryAt ?? null,
        runEndReason,
        runLogCount: runLogs.length,
        runStatus,
        taskNotice,
        turnRecordCount: turnRecords.length,
        watchDir,
        workDir,
      }),
    };

    return () => {
      delete window.__REBUILDCHAT_TEST_API__;
    };
    // eslint-disable-next-line max-len
  }, [conversationId, currentTaskId, currentTurnIndex, effectiveMaxRounds, retryState?.retryAttemptCount, retryState?.retryAt, runEndReason, runLogs.length, runStatus, taskNotice, turnRecords.length, watchDir, workDir]);

  const executeQueue = async (startIndex: number, initialConversationId: string | null, effectiveWatchDir: string) => {
    const runtime = getRebuildChatRuntimeDriver();
    const runConfig = {
      includeHistoryContext: pageStateRef.current.includeHistoryContext,
      maxRounds: computeEffectiveMaxRounds(pageStateRef.current.maxRoundsInput, queueRef.current.length),
      skipPermissions: pageStateRef.current.skipPermissions,
      stopOnNoChanges: pageStateRef.current.stopOnNoChanges,
      watchExtensionsInput: pageStateRef.current.watchExtensionsInput,
      workDir: pageStateRef.current.workDir,
    };
    const result = await executeRebuildChatRun({
      queue: queueRef.current,
      startIndex,
      initialConversationId,
      includeHistoryContext: runConfig.includeHistoryContext,
      maxRounds: runConfig.maxRounds,
      stopOnNoChanges: runConfig.stopOnNoChanges,
      onTurnStart: ({ turnIndex }) => {
        setActiveTurnState('running');
        setCurrentTurnIndex(turnIndex);
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
      executeTurn: async ({ prompt, conversationId: activeConversationId }) => {
        const beforeSnapshot = effectiveWatchDir ? await runtime.snapshotDirectory(effectiveWatchDir, runConfig.watchExtensionsInput) : {};
        const execution = await runtime.startAgyPrintTurn({
          prompt,
          cwd: runConfig.workDir,
          conversationId: activeConversationId,
          skipPermissions: runConfig.skipPermissions,
        });
        currentExecutionRef.current = execution;
        const turnResult = await execution.promise;
        currentExecutionRef.current = null;
        const afterSnapshot = effectiveWatchDir ? await runtime.snapshotDirectory(effectiveWatchDir, runConfig.watchExtensionsInput) : {};
        const fileChanges = runtime.compareDirectorySnapshots(beforeSnapshot, afterSnapshot);
        const quotaRetry = parseQuotaRetry({
          output: turnResult.output,
          rawLog: turnResult.rawLog,
        });

        return {
          conversationId: turnResult.conversationId ?? activeConversationId,
          exitCode: turnResult.exitCode,
          output: turnResult.output,
          fileChanges,
          retryDirective: quotaRetry.directive,
        };
      },
      onConversationId: (nextConversationId) => {
        setConversationId(nextConversationId);
      },
      onCurrentTurnIndex: (turnIndex) => {
        setCurrentTurnIndex(turnIndex);
      },
      onTurnAdvanced: (turnIndex) => {
        setActiveTurnState('idle');
        persistCurrentTask({
          progress: {
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
        const nextTurnRecords = [...pageStateRef.current.turnRecords, nextRecord];
        if (record.status === 'completed') {
          setActiveTurnState('completed_not_advanced');
        }
        setTurnRecords((previous) => [...previous, nextRecord]);
        persistCurrentTask({
          progress: {
            currentTurnIndex: Math.max(record.turnNumber - 1, 0),
            turnRecords: nextTurnRecords,
            activeTurnState: record.status === 'completed' ? 'completed_not_advanced' : pageStateRef.current.activeTurnState,
            retryState: null,
          },
        });
      },
    });

    if (result.status === 'waiting_retry' && result.retryDirective) {
      const previousAttemptCount = pageStateRef.current.retryState?.retryAttemptCount ?? 0;
      const nextRetryState: RetryState = {
        reason: 'quota',
        retryAt: result.retryDirective.retryAt,
        retryDelayMs: result.retryDirective.retryDelayMs,
        retryAttemptCount: previousAttemptCount + 1,
        resumeTurnIndex: result.nextTurnIndex,
        lastMatchedMessage: result.retryDirective.matchedText,
        source: result.retryDirective.source,
      };
      const retryMessage = result.retryDirective.retryAt === null ? `当前轮命中额度限制，将按固定间隔 ${formatRetryDelay(result.retryDirective.retryDelayMs)} 自动重试。` : `当前轮命中额度限制，将在 ${formatRetryClock(result.retryDirective.retryAt)} 后自动重试，剩余约 ${formatRetryRemaining(result.retryDirective.retryAt, Date.now())}。`;

      retryAutoResumeRef.current = true;
      clearRetryTimeout();
      currentExecutionRef.current = null;
      setRetryState(nextRetryState);
      setRunStatus('waiting_retry');
      setRunEndReason(null);
      setCurrentTurnIndex(result.nextTurnIndex);
      setActiveTurnState('idle');
      appendRunLog('system', retryMessage);
      persistCurrentTask({
        status: 'waiting_retry',
        progress: {
          currentTurnIndex: result.nextTurnIndex,
          runEndReason: null,
          activeTurnState: 'idle',
          retryState: nextRetryState,
        },
      });
      return;
    }

    finishRun(result.status, result.endReason, result.nextTurnIndex);
  };

  const currentPersistedTask = useMemo(() => {
    return persistedTasks.find((task) => task.taskId === currentTaskId) || null;
  }, [currentTaskId, persistedTasks]);

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

  const resumeExecution = (startIndex: number, initialConversationId: string | null, effectiveWatchDir: string, logText: string) => {
    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    retryAutoResumeRef.current = false;
    clearRetryTimeout();
    setTaskNotice('');
    setCurrentTurnIndex(startIndex);
    setActiveTurnState('idle');
    setRunEndReason(null);
    setRunStatus('running');
    setRetryState(null);
    persistCurrentTask({
      status: 'running',
      progress: {
        currentTurnIndex: startIndex,
        runEndReason: null,
        activeTurnState: 'idle',
        retryState: null,
      },
    });
    appendRunLog('system', logText);
    void executeQueue(startIndex, initialConversationId, effectiveWatchDir);
  };

  const applyPersistedTask = (task: RebuildChatPersistedTask, resumeMode: boolean = false) => {
    applyingTaskRef.current = true;
    queueRebuildSuppressedRef.current = 3;
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
    setIncludeHistoryContext(task.includeHistoryContext);
    setStopOnNoChanges(task.stopOnNoChanges);
    setSkipPermissions(task.skipPermissions);
    setConversationId(task.progress.conversationId);
    setCurrentTurnIndex(task.progress.currentTurnIndex);
    setRunEndReason(task.progress.runEndReason);
    setRunLogs(task.progress.runLogs.map((entry) => ({ ...entry })));
    setTurnRecords(task.progress.turnRecords.map((record) => ({ ...record })));
    setRetryState(task.progress.retryState ? { ...task.progress.retryState } : null);
    setRunStatus(normalizeLoadedRunStatus(task));
    setActiveTurnState('idle');

    const notices: string[] = [];
    if (!resumeMode && (task.status === 'running' || task.status === 'stopping')) {
      notices.push('这个任务上次关闭时仍在运行，恢复时会从未确认完成的轮次继续。');
    }
    if (task.status === 'waiting_retry' && task.progress.retryState) {
      notices.push(`这个任务正处于额度等待状态。点击“恢复并继续”会先立即重试一次；若仍受限，则继续等待到 ${formatRetryClock(task.progress.retryState.retryAt)}。`);
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

  const handleLoadTask = (task: RebuildChatPersistedTask) => {
    applyPersistedTask(task, false);
    Message.success(`已载入任务：${getTaskTitle(task)}`);
  };

  const handleResumeTask = async (task: RebuildChatPersistedTask) => {
    applyPersistedTask(task, true);
    const { canRun, effectiveWatchDir } = await resolveExecutionEnvironment(task.workDir, task.watchDir);
    if (!canRun) {
      return;
    }

    appendRunLog('system', `已准备恢复任务，将继续第 ${getRebuildChatTaskResumeIndex(task) + 1} 轮。`);
    window.setTimeout(() => {
      resumeExecution(getRebuildChatTaskResumeIndex(task), task.progress.conversationId, effectiveWatchDir, `从持久化任务恢复，将从第 ${getRebuildChatTaskResumeIndex(task) + 1} 轮继续运行。`);
    }, 0);
  };

  const handleDeleteTask = async (taskId: string) => {
    if (currentTaskIdRef.current === taskId) {
      currentTaskIdRef.current = null;
      setCurrentTaskId(null);
    }

    commitPersistedTasks(persistedTasksRef.current.filter((task) => task.taskId !== taskId));
    await saveTasksPromiseRef.current;
    Message.success('已删除任务记录。');
  };

  useEffect(() => {
    if (runStatus !== 'waiting_retry' || !retryState?.retryAt) {
      return;
    }

    setRetryClockNow(Date.now());
    const intervalId = window.setInterval(() => {
      setRetryClockNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [retryState?.retryAt, runStatus]);

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

        resumeExecution(activeRetryState.resumeTurnIndex, pageStateRef.current.conversationId, effectiveWatchDir, '额度等待结束，重新发送当前轮。');
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

      const { canRun, effectiveWatchDir } = await resolveExecutionEnvironment(workDir, watchDir);
      if (!canRun) {
        return;
      }

      const shouldForkTask = Boolean(currentPersistedTask && currentPersistedTask.status !== 'idle');
      const startLog = createRunLogEntry('system', '开始新一轮运行。');
      const nextTaskId = shouldForkTask || !currentTaskIdRef.current ? uuid() : currentTaskIdRef.current;
      const createdAt = shouldForkTask || !currentPersistedTask ? Date.now() : currentPersistedTask.createdAt;

      currentTaskIdRef.current = nextTaskId;
      setCurrentTaskId(nextTaskId);
      pauseRequestedRef.current = false;
      abortRequestedRef.current = false;
      retryAutoResumeRef.current = false;
      clearRetryTimeout();
      setRunLogs([startLog]);
      setTurnRecords([]);
      setConversationId(null);
      setCurrentTurnIndex(0);
      setRunEndReason(null);
      setRunStatus('running');
      setActiveTurnState('idle');
      setRetryState(null);
      setTaskNotice('');
      const nextTask = buildPersistedTask(nextTaskId, createdAt, {
        status: 'running',
        progress: {
          conversationId: null,
          currentTurnIndex: 0,
          effectiveMaxRounds,
          runEndReason: null,
          runLogs: [startLog],
          turnRecords: [],
          activeTurnState: 'idle',
          retryState: null,
        },
      });
      commitPersistedTasks([nextTask, ...persistedTasksRef.current.filter((task) => task.taskId !== nextTaskId)]);
      void executeQueue(0, null, effectiveWatchDir);
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
      const { canRun, effectiveWatchDir } = await resolveExecutionEnvironment(workDir, watchDir);
      if (!canRun) {
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

  const retrySummaryText = runStatus === 'waiting_retry' && retryState ? (retryState.retryAt === null ? `当前轮因额度限制暂停，按固定间隔 ${formatRetryDelay(retryState.retryDelayMs)} 自动重试。` : `当前轮因额度限制暂停，将在 ${formatRetryClock(retryState.retryAt)} 自动重试，剩余约 ${formatRetryRemaining(retryState.retryAt, retryClockNow)}。`) : '';

  return (
    <div className={styles.page} data-testid='rebuildchat-page'>
      <div className={styles.shell}>
        <section className={styles.hero}>
          <div className={styles.heroText}>
            <div className={styles.heroTitle}>RebuildChat 首板工作台</div>
            <Paragraph className={styles.heroDesc}>现在已经不只是提取和编辑队列了，这一版还把 `agy` 单轮执行、会话延续、开始 / 暂停 / 继续 / 中止、以及按目录快照判断文件产出一起接上了。后续还需要继续收口体验，但核心闭环已经在往真运行靠拢。</Paragraph>
            <div className={styles.heroMeta}>
              <div className={styles.heroMetaCard}>
                <div className={styles.heroMetaLabel}>当前阶段</div>
                <div className={styles.heroMetaValue}>Step 6-8</div>
              </div>
              <div className={styles.heroMetaCard}>
                <div className={styles.heroMetaLabel}>固定 Agent</div>
                <div className={styles.heroMetaValue}>agy</div>
              </div>
              <div className={styles.heroMetaCard}>
                <div className={styles.heroMetaLabel}>运行状态</div>
                <div className={styles.heroMetaValue}>{runStatus}</div>
              </div>
            </div>
          </div>
        </section>

        <div className={styles.grid}>
          <div className={`${styles.column} ${styles.leftColumn}`}>
            <Card className={styles.panel} bordered={false}>
              <div className={styles.panelTitle}>0. 任务列表</div>
              <div className={styles.panelDesc}>这里保留本机已保存的 RebuildChat 任务。关闭程序后，下次可以在这里载入查看，或从上次进度继续跑。</div>

              <Space direction='vertical' size={12} style={{ width: '100%', marginTop: 16 }}>
                {taskNotice ? <div className={styles.notice}>{taskNotice}</div> : null}
                {persistedTasks.length ? (
                  <div className={styles.taskList} data-testid='task-list'>
                    {persistedTasks.map((task) => (
                      <div key={task.taskId} className={styles.taskCard} data-testid='task-card'>
                        <div className={styles.taskHeader}>
                          <div>
                            <div className={styles.taskTitle}>{getTaskTitle(task)}</div>
                            <div className={styles.taskMeta}>
                              {task.status === 'completed' || task.status === 'aborted' ? <Tag color={task.status === 'completed' ? 'green' : 'orange'}>{getTaskStatusLabel(task.status)}</Tag> : task.status === 'failed' ? <Tag color='red'>{getTaskStatusLabel(task.status)}</Tag> : task.status === 'paused' ? <Tag color='blue'>{getTaskStatusLabel(task.status)}</Tag> : task.status === 'waiting_retry' ? <Tag color='orange'>{getTaskStatusLabel(task.status)}</Tag> : <Tag>{getTaskStatusLabel(task.status)}</Tag>}
                              <Tag color='gray'>{getTaskProgressLabel(task)}</Tag>
                              {task.progress.conversationId ? <Tag color='gray'>{task.progress.conversationId.slice(0, 8)}</Tag> : null}
                            </div>
                          </div>
                          <div className={styles.taskMetaText}>{new Date(task.updatedAt).toLocaleString()}</div>
                        </div>

                        <div className={styles.taskMetaText}>{task.workDir || '未设置工作目录'}</div>
                        {task.progress.retryState ? (
                          <div className={styles.taskMetaText}>
                            下次重试：{formatRetryClock(task.progress.retryState.retryAt)}，约 {formatRetryDelay(task.progress.retryState.retryDelayMs)} 后，已等待 {task.progress.retryState.retryAttemptCount} 次。
                          </div>
                        ) : null}

                        <div className={styles.taskActions}>
                          {canResumeRebuildChatTask(task) ? (
                            <Button data-testid='task-resume-button' size='small' type='primary' onClick={() => void handleResumeTask(task)}>
                              恢复并继续
                            </Button>
                          ) : null}
                          <Button data-testid='task-load-button' size='small' onClick={() => void handleLoadTask(task)}>
                            载入查看
                          </Button>
                          <Button data-testid='task-delete-button' size='small' status='danger' onClick={() => void handleDeleteTask(task.taskId)}>
                            删除记录
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.queueEmpty}>
                    <Empty description='还没有保存过 RebuildChat 任务。导入文件并开始编辑后，这里会自动出现任务记录。' />
                  </div>
                )}
              </Space>
            </Card>

            <Card className={styles.panel} bordered={false}>
              <div className={styles.panelTitle}>1. 输入区</div>
              <div className={styles.panelDesc}>先选文件，再确认过滤条件。切换过滤条件会重建待发送队列。</div>

              <Space direction='vertical' size={16} style={{ width: '100%', marginTop: 16 }}>
                <Space wrap>
                  <Button data-testid='pick-json-file' type='primary' icon={<UploadOne theme='outline' size='18' fill='currentColor' />} loading={loading} disabled={isRunLocked} onClick={handlePickFile}>
                    选择 JSON 文件
                  </Button>
                  <Button data-testid='reload-json-file' icon={<Refresh theme='outline' size='18' fill='currentColor' />} disabled={!filePath || loading || isRunLocked} onClick={handleReload}>
                    重新读取
                  </Button>
                </Space>

                <div className={styles.pathBox}>{filePath || '还没有选择文件。'}</div>

                <div>
                  <Text style={{ display: 'block', marginBottom: 8 }}>默认过滤 thought</Text>
                  <Switch checked={excludeThought} disabled={isRunLocked} onChange={(checked) => setExcludeThought(checked)} />
                </div>

                <div>
                  <Text style={{ display: 'block', marginBottom: 8 }}>role 多选</Text>
                  <div className={styles.roleWrap}>
                    {(parseResult?.availableRoles || []).map((role) => {
                      const checked = selectedRoles.includes(role);
                      return (
                        <Tag key={role} checkable checked={checked} onCheck={() => !isRunLocked && toggleRole(role)} color={checked ? 'blue' : undefined}>
                          {role}
                        </Tag>
                      );
                    })}
                  </div>
                  <div className={styles.roleHint}>{parseResult ? `可选角色 ${parseResult.availableRoles.length} 个，当前选中 ${selectedRoles.length} 个。` : '选择文件后会在这里展示可用 role。'}</div>
                </div>

                {errorText ? <div className={styles.notice}>{errorText}</div> : null}
              </Space>
            </Card>

            <Card className={styles.panel} bordered={false}>
              <div className={styles.panelTitle}>2. 解析摘要</div>
              <div className={styles.panelDesc}>这里展示文件提取阶段的核心统计，方便确认过滤是否符合预期。</div>

              <Space direction='vertical' size={12} style={{ width: '100%', marginTop: 16 }}>
                <div className={styles.pathBox}>总 chunk 数：{parseResult?.totalChunks ?? 0}</div>
                <div className={styles.pathBox}>默认过滤的 thought 数：{parseResult?.filteredOutThoughts ?? 0}</div>
                <div className={styles.pathBox}>因结构异常跳过的 chunk 数：{parseResult?.skippedInvalidChunks ?? 0}</div>
                <div className={styles.pathBox}>当前进入队列前的有效 chunk 数：{filteredChunks.length}</div>
              </Space>
            </Card>

            <Card className={styles.panel} bordered={false}>
              <div className={styles.panelTitle}>4. 运行配置</div>
              <div className={styles.panelDesc}>这里先做首版最少配置：工作目录、产出监控目录、历史上下文策略、最大轮数与停止规则。</div>

              <Space direction='vertical' size={16} style={{ width: '100%', marginTop: 16 }}>
                <div>
                  <Text style={{ display: 'block', marginBottom: 8 }}>agy 工作目录</Text>
                  <div className={styles.inlinePicker}>
                    <Input value={workDir} disabled={isRunLocked} placeholder='选择 agy 运行目录' onChange={setWorkDir} />
                    <Button disabled={isRunLocked} onClick={() => void pickDirectory(setWorkDir)}>
                      选目录
                    </Button>
                  </div>
                </div>

                <div>
                  <Text style={{ display: 'block', marginBottom: 8 }}>产出监控目录</Text>
                  <div className={styles.inlinePicker}>
                    <Input value={watchDir} disabled={isRunLocked} placeholder='选择要监控的目录' onChange={setWatchDir} />
                    <Button disabled={isRunLocked} onClick={() => void pickDirectory(setWatchDir)}>
                      选目录
                    </Button>
                  </div>
                </div>

                <div className={styles.configGrid}>
                  <div>
                    <Text style={{ display: 'block', marginBottom: 8 }}>监控后缀</Text>
                    <Input value={watchExtensionsInput} disabled={isRunLocked} placeholder='.md,.ts,.json，留空表示全部' onChange={setWatchExtensionsInput} />
                  </div>
                  <div>
                    <Text style={{ display: 'block', marginBottom: 8 }}>最大轮数</Text>
                    <Input value={maxRoundsInput} disabled={isRunLocked} placeholder='留空表示跑完整个队列' onChange={setMaxRoundsInput} />
                  </div>
                </div>

                <div className={styles.toggleGrid}>
                  <div className={styles.toggleRow}>
                    <div>
                      <div className={styles.toggleTitle}>第二轮起拼接历史</div>
                      <div className={styles.roleHint}>关闭时每轮只发当前条目，开启时会把前面条目一起拼进 prompt。</div>
                    </div>
                    <Switch checked={includeHistoryContext} disabled={isRunLocked} onChange={(checked) => setIncludeHistoryContext(checked)} />
                  </div>

                  <div className={styles.toggleRow}>
                    <div>
                      <div className={styles.toggleTitle}>无产出自动停止</div>
                      <div className={styles.roleHint}>如果本轮前后目录快照没有新增 / 修改 / 删除，就结束运行。</div>
                    </div>
                    <Switch checked={stopOnNoChanges} disabled={isRunLocked} onChange={(checked) => setStopOnNoChanges(checked)} />
                  </div>

                  <div className={styles.toggleRow}>
                    <div>
                      <div className={styles.toggleTitle}>自动跳过权限确认</div>
                      <div className={styles.roleHint}>会追加 `--dangerously-skip-permissions`，适合内部环境快速跑通，但风险更高。</div>
                    </div>
                    <Switch checked={skipPermissions} disabled={isRunLocked} onChange={(checked) => setSkipPermissions(checked)} />
                  </div>
                </div>
              </Space>
            </Card>
          </div>

          <div className={`${styles.column} ${styles.middleColumn}`}>
            <Card className={`${styles.panel} ${styles.editPanel}`} bordered={false}>
              <div className={styles.panelTitle}>3. 编辑区</div>
              <div className={styles.panelDesc}>现在的发送队列来自当前过滤结果。你可以新增自定义条目，或对某几条做勾选删除和文本修改。</div>

              <Space direction='vertical' size={16} className={styles.editPanelBody} style={{ width: '100%', marginTop: 16 }}>
                <div className={styles.notice}>切换 role 或 thought 过滤开关时，会按当前规则重新生成队列，之前的临时编辑不会保留。</div>

                <Space wrap>
                  <Button data-testid='queue-add-custom' type='primary' icon={<Plus theme='outline' size='18' fill='currentColor' />} onClick={handleAddCustom} disabled={isRunLocked}>
                    新增自定义条目
                  </Button>
                  <Button data-testid='queue-delete-selected' status='danger' icon={<Delete theme='outline' size='18' fill='currentColor' />} disabled={!selectedQueueIds.length || isRunLocked} onClick={handleDeleteSelected}>
                    删除选中项
                  </Button>
                </Space>

                <div className={styles.heroMeta}>
                  <div className={styles.heroMetaCard} data-testid='queue-total-card'>
                    <div className={styles.heroMetaLabel}>队列总数</div>
                    <div className={styles.heroMetaValue} data-testid='queue-total-value'>
                      {queueStats.total}
                    </div>
                  </div>
                  <div className={styles.heroMetaCard}>
                    <div className={styles.heroMetaLabel}>已编辑</div>
                    <div className={styles.heroMetaValue}>{queueStats.editedCount}</div>
                  </div>
                  <div className={styles.heroMetaCard}>
                    <div className={styles.heroMetaLabel}>自定义</div>
                    <div className={styles.heroMetaValue}>{queueStats.customCount}</div>
                  </div>
                </div>

                {queue.length ? (
                  <div className={styles.queueList}>
                    {queue.map((item, index) => (
                      <div key={item.id} className={styles.queueCard}>
                        <div className={styles.queueHeader}>
                          <div className={styles.queueHeaderLeft}>
                            <Checkbox checked={selectedQueueIds.includes(item.id)} disabled={isRunLocked} onChange={() => toggleQueueSelection(item.id)} />
                            <Text bold>第 {index + 1} 条</Text>
                            <div className={styles.queueMeta}>
                              {item.isCustom ? <Tag color='green'>自定义</Tag> : <Tag color='blue'>提取项</Tag>}
                              {item.edited ? <Tag color='orange'>已编辑</Tag> : <Tag>原始</Tag>}
                              {item.sourceIndex !== null ? <Tag color='gray'>source #{item.sourceIndex + 1}</Tag> : null}
                              {item.tokenCount !== null ? <Tag color='gray'>{item.tokenCount} tokens</Tag> : null}
                            </div>
                          </div>
                          <Button size='small' status='danger' disabled={isRunLocked} onClick={() => handleDeleteSingle(item.id)}>
                            删除
                          </Button>
                        </div>

                        <div className={styles.queueRow}>
                          <Input value={item.role} disabled={isRunLocked} placeholder='role' onChange={(value) => handleQueueChange(item.id, { role: value })} />
                          <Input.TextArea value={item.text} disabled={isRunLocked} placeholder='输入要发送给 agy 的文本' autoSize={{ minRows: 3, maxRows: 12 }} onChange={(value) => handleQueueChange(item.id, { text: value })} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.queueEmpty}>
                    <Empty description={parseResult ? '当前过滤条件下没有可进入队列的内容，你可以调整 role 或关闭 thought 过滤后再试。' : '先导入一个 JSON 对话文件，这里才会生成待发送队列。'} />
                  </div>
                )}
              </Space>
            </Card>
          </div>

          <div className={`${styles.column} ${styles.rightColumn}`}>
            <Card className={`${styles.panel} ${styles.runPanel}`} bordered={false}>
              <div className={styles.panelTitle}>5. 运行区</div>
              <div className={styles.panelDesc}>这里先接最小闭环：顺序发送、持续会话、暂停 / 继续 / 中止、按目录快照判断产出。</div>

              <Space direction='vertical' size={16} style={{ width: '100%', marginTop: 16 }}>
                <div className={styles.runtimeSummary}>
                  <div className={styles.heroMetaCard} data-testid='run-status-card'>
                    <div className={styles.heroMetaLabel}>当前状态</div>
                    <div className={styles.heroMetaValue} data-testid='run-status-value'>
                      {runStatus}
                    </div>
                  </div>
                  <div className={styles.heroMetaCard}>
                    <div className={styles.heroMetaLabel}>下一轮</div>
                    <div className={styles.heroMetaValue}>{Math.min(currentTurnIndex + 1, Math.max(queue.length, 1))}</div>
                  </div>
                  <div className={styles.heroMetaCard} data-testid='run-end-reason-card'>
                    <div className={styles.heroMetaLabel}>结束原因</div>
                    <div className={styles.heroMetaValueSmall} data-testid='run-end-reason-value'>
                      {getEndReasonLabel(runEndReason)}
                    </div>
                  </div>
                </div>

                {retrySummaryText ? (
                  <div className={styles.waitNotice} data-testid='run-retry-waiting'>
                    <div>额度等待：{retrySummaryText}</div>
                    <div>恢复方式：继续当前会话，重发第 {(retryState?.resumeTurnIndex ?? currentTurnIndex) + 1} 轮。</div>
                    {retryState?.lastMatchedMessage ? <div>最近提示：{retryState.lastMatchedMessage}</div> : null}
                  </div>
                ) : null}

                <Space wrap>
                  <Button data-testid='run-start' type='primary' icon={<Play theme='outline' size='18' fill='currentColor' />} disabled={runStatus === 'running' || runStatus === 'stopping' || runStatus === 'waiting_retry' || !queue.length} onClick={handleStart}>
                    开始
                  </Button>
                  <Button data-testid='run-pause' icon={<Pause theme='outline' size='18' fill='currentColor' />} disabled={runStatus !== 'running'} onClick={handlePause}>
                    暂停
                  </Button>
                  <Button data-testid='run-resume' icon={<Right theme='outline' size='18' fill='currentColor' />} disabled={runStatus !== 'paused'} onClick={handleResume}>
                    继续
                  </Button>
                  <Button data-testid='run-abort' status='danger' icon={<CloseOne theme='outline' size='18' fill='currentColor' />} disabled={runStatus !== 'running' && runStatus !== 'stopping' && runStatus !== 'paused' && runStatus !== 'waiting_retry'} onClick={() => void handleAbort()}>
                    中止
                  </Button>
                </Space>

                <div className={styles.pathBox} data-testid='conversation-id-box'>
                  conversationId：{conversationId || '还没有拿到 agy 会话 ID。'}
                </div>
                <div className={styles.pathBox} data-testid='effective-max-rounds-box'>
                  有效最大轮数：{effectiveMaxRounds || 0}
                </div>

                <div className={styles.logPanel} data-testid='run-log-panel'>
                  {runLogs.length ? (
                    runLogs.map((entry) => (
                      <div key={entry.id} className={styles.logRow} data-testid='run-log-row'>
                        <span className={styles.logTime}>{entry.timestamp}</span>
                        <span className={styles.logKind}>{entry.kind}</span>
                        <span className={styles.logText}>{entry.text}</span>
                      </div>
                    ))
                  ) : (
                    <div className={styles.logPlaceholder}>还没有运行日志。</div>
                  )}
                </div>
              </Space>
            </Card>

            <Card className={`${styles.panel} ${styles.observePanel}`} bordered={false}>
              <div className={styles.panelTitle}>6. 观察区</div>
              <div className={styles.panelDesc}>每轮都会记录 prompt、agy 输出摘要、文件变化摘要和状态，方便后续做联调与验收。</div>

              <Space direction='vertical' size={16} className={styles.observePanelBody} style={{ width: '100%', marginTop: 16 }}>
                {turnRecords.length ? (
                  <div className={styles.turnRecordList} data-testid='turn-record-list'>
                    {turnRecords.map((record) => (
                      <div key={record.id} className={styles.turnRecordCard} data-testid='turn-record-card'>
                        <div className={styles.turnRecordHeader}>
                          <Text bold>第 {record.turnNumber} 轮</Text>
                          <div className={styles.queueMeta}>
                            <Tag color='blue'>{record.role}</Tag>
                            <Tag color={record.status === 'completed' ? 'green' : record.status === 'aborted' ? 'orange' : 'red'}>{record.status}</Tag>
                            {record.conversationId ? <Tag color='gray'>{record.conversationId.slice(0, 8)}</Tag> : null}
                          </div>
                        </div>

                        <div className={styles.turnRecordBlock}>
                          <div className={styles.turnRecordLabel}>发送内容</div>
                          <pre className={styles.turnRecordText}>{record.prompt}</pre>
                        </div>

                        <div className={styles.turnRecordBlock}>
                          <div className={styles.turnRecordLabel}>agy 输出</div>
                          <pre className={styles.turnRecordText}>{record.output || '(空输出)'}</pre>
                        </div>

                        <div className={styles.turnRecordBlock}>
                          <div className={styles.turnRecordLabel}>文件变化</div>
                          <div className={styles.roleHint}>{summarizeFileChanges(record.fileChanges)}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className={styles.queueEmpty}>
                    <Empty description='开始运行后，这里会记录每一轮的输入、输出和文件变化。' />
                  </div>
                )}
              </Space>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
};

export default RebuildChatPage;
