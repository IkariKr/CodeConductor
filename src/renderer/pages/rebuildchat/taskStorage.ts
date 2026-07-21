import { ipcBridge } from '@/common';
import { ConfigStorage } from '@/common/storage';
import { mergeRebuildChatTasks, normalizeRebuildChatTaskMeta, normalizeRebuildChatTaskSummaries, normalizeRebuildChatTasks, sortRebuildChatTaskSummaries, toRebuildChatPersistedTaskMeta, toRebuildChatPersistedTaskSourceSnapshot, toRebuildChatPersistedTaskSummaryFromMeta, type RebuildChatPersistedLogEntry, type RebuildChatPersistedStartPromptRecord, type RebuildChatPersistedTask, type RebuildChatPersistedTaskMeta, type RebuildChatPersistedTaskPreview, type RebuildChatPersistedTaskSourceSnapshot, type RebuildChatPersistedTaskSummary, type RebuildChatPersistedTurnRecord, type RebuildChatTaskHistoryKind, type RebuildChatTaskHistorySlice } from '@/common/rebuildchat/persistedTask';

const REBUILDCHAT_TASK_INDEX_FILE = 'rebuildchat.task-index.json';
const REBUILDCHAT_TASK_DIR_PREFIX = 'rebuildchat.task.';
const REBUILDCHAT_TASK_META_FILE = 'meta.json';
const REBUILDCHAT_TASK_SOURCE_FILE = 'source.json';
const REBUILDCHAT_TASK_RUN_LOG_FILE = 'run-logs.jsonl';
const REBUILDCHAT_TASK_TURN_RECORD_FILE = 'turn-records.jsonl';
const REBUILDCHAT_TASK_START_PROMPT_FILE = 'start-prompts.jsonl';
const LEGACY_REBUILDCHAT_TASK_BACKUP_FILE_PATTERN = /^rebuildchat\.tasks(?:\.legacy-backup-.*)?\.json$/i;
const LEGACY_REBUILDCHAT_TASK_DETAIL_FILE_PATTERN = /^rebuildchat\.task\.[^.]+\.json$/i;
const LEGACY_REBUILDCHAT_CONFIG_FILE = 'CodeConductor-config.txt';

type HistoryEntryMap = {
  runLogs: RebuildChatPersistedLogEntry;
  startPromptRecords: RebuildChatPersistedStartPromptRecord;
  turnRecords: RebuildChatPersistedTurnRecord;
};

type HistoryLimitMap = Partial<Record<RebuildChatTaskHistoryKind, number>>;

let cacheDirPromise: Promise<string> | null = null;
let migrationPromise: Promise<void> | null = null;
let legacyStorageCleared = false;

const joinPath = (dir: string, fileName: string): string => {
  const trimmedDir = dir.replace(/[\\/]+$/, '');
  const separator = trimmedDir.includes('\\') ? '\\' : '/';
  return `${trimmedDir}${separator}${fileName}`;
};

const getCacheDir = (): Promise<string> => {
  if (!cacheDirPromise) {
    cacheDirPromise = ipcBridge.application.systemInfo.invoke().then((systemInfo) => systemInfo.cacheDir);
  }

  return cacheDirPromise;
};

const getTaskDirPath = async (taskId: string): Promise<string> => {
  return joinPath(await getCacheDir(), `${REBUILDCHAT_TASK_DIR_PREFIX}${taskId}`);
};

const getTaskMetaPath = async (taskId: string): Promise<string> => {
  return joinPath(await getTaskDirPath(taskId), REBUILDCHAT_TASK_META_FILE);
};

const getTaskSourcePath = async (taskId: string): Promise<string> => {
  return joinPath(await getTaskDirPath(taskId), REBUILDCHAT_TASK_SOURCE_FILE);
};

const getTaskHistoryPath = async (taskId: string, kind: RebuildChatTaskHistoryKind): Promise<string> => {
  const fileName = kind === 'runLogs' ? REBUILDCHAT_TASK_RUN_LOG_FILE : kind === 'turnRecords' ? REBUILDCHAT_TASK_TURN_RECORD_FILE : REBUILDCHAT_TASK_START_PROMPT_FILE;
  return joinPath(await getTaskDirPath(taskId), fileName);
};

const getTaskIndexPath = async (): Promise<string> => {
  return joinPath(await getCacheDir(), REBUILDCHAT_TASK_INDEX_FILE);
};

const getLegacyConfigPath = async (): Promise<string> => {
  return joinPath(await getCacheDir(), LEGACY_REBUILDCHAT_CONFIG_FILE);
};

const getHistoryFileName = (kind: RebuildChatTaskHistoryKind): string => {
  return kind === 'runLogs' ? REBUILDCHAT_TASK_RUN_LOG_FILE : kind === 'turnRecords' ? REBUILDCHAT_TASK_TURN_RECORD_FILE : REBUILDCHAT_TASK_START_PROMPT_FILE;
};

const readTextFile = async (filePath: string): Promise<{ exists: boolean; content: string | null }> => {
  try {
    return {
      exists: true,
      content: await ipcBridge.fs.readFile.invoke({ path: filePath }),
    };
  } catch {
    return {
      exists: false,
      content: null,
    };
  }
};

const writeTextFile = async (filePath: string, content: string): Promise<void> => {
  const writeSucceeded = await ipcBridge.fs.writeFile.invoke({ path: filePath, data: content });
  if (writeSucceeded !== true) {
    throw new Error(`[RebuildChat] Failed to write task storage file: ${filePath}`);
  }
};

const appendTextFile = async (filePath: string, content: string): Promise<void> => {
  const appendSucceeded = await ipcBridge.fs.appendFile.invoke({ path: filePath, data: content });
  if (appendSucceeded !== true) {
    throw new Error(`[RebuildChat] Failed to append task storage file: ${filePath}`);
  }
};

const removePathIfExists = async (filePath: string): Promise<void> => {
  const result = await ipcBridge.fs.removeEntry.invoke({ path: filePath });
  if (!result.success && !/ENOENT|no such file or directory/i.test(result.msg || '')) {
    throw new Error(result.msg || `[RebuildChat] Failed to remove path: ${filePath}`);
  }
};

const decodeLegacyConfig = (raw: string): Record<string, unknown> => {
  return JSON.parse(decodeURIComponent(atob(raw))) as Record<string, unknown>;
};

const normalizeSourceSnapshot = (value: unknown): RebuildChatPersistedTaskSourceSnapshot | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as Partial<RebuildChatPersistedTaskSourceSnapshot>;
  if (typeof candidate.filePath !== 'string' || typeof candidate.rawContent !== 'string' || typeof candidate.excludeThought !== 'boolean' || !Array.isArray(candidate.selectedRoles) || !candidate.selectedRoles.every((item) => typeof item === 'string') || !Array.isArray(candidate.queueSnapshot)) {
    return null;
  }

  return {
    filePath: candidate.filePath,
    rawContent: candidate.rawContent,
    excludeThought: candidate.excludeThought,
    selectedRoles: [...candidate.selectedRoles],
    queueSnapshot: candidate.queueSnapshot.map((item) => ({ ...((item as unknown as Record<string, unknown>) || {}) })) as unknown as RebuildChatPersistedTaskSourceSnapshot['queueSnapshot'],
  };
};

const mergeTaskSummaries = (...taskGroups: RebuildChatPersistedTaskSummary[][]): RebuildChatPersistedTaskSummary[] => {
  const summaryMap = new Map<string, RebuildChatPersistedTaskSummary>();

  for (const group of taskGroups) {
    for (const task of group) {
      const existing = summaryMap.get(task.taskId);
      if (!existing || task.updatedAt >= existing.updatedAt) {
        summaryMap.set(task.taskId, task);
      }
    }
  }

  return sortRebuildChatTaskSummaries([...summaryMap.values()]);
};

const listCacheEntryNames = async (): Promise<string[]> => {
  const cacheDir = await getCacheDir();
  const tree = await ipcBridge.fs.getFilesByDir.invoke({
    dir: cacheDir,
    root: cacheDir,
    maxDepth: 1,
  });

  return tree[0]?.children?.map((entry) => entry.name) ?? [];
};

const listTaskDirEntryNames = async (taskId: string): Promise<Set<string>> => {
  const taskDir = await getTaskDirPath(taskId);

  try {
    const tree = await ipcBridge.fs.getFilesByDir.invoke({
      dir: taskDir,
      root: taskDir,
      maxDepth: 1,
    });

    return new Set(tree[0]?.children?.map((entry) => entry.name) ?? []);
  } catch {
    return new Set();
  }
};

const readTaskIndexFile = async (): Promise<RebuildChatPersistedTaskSummary[]> => {
  const { content } = await readTextFile(await getTaskIndexPath());
  if (!content) {
    return [];
  }

  return normalizeRebuildChatTaskSummaries(JSON.parse(content) as unknown);
};

const writeTaskIndexFile = async (tasks: RebuildChatPersistedTaskSummary[]): Promise<RebuildChatPersistedTaskSummary[]> => {
  const normalizedTasks = sortRebuildChatTaskSummaries(tasks);
  await writeTextFile(await getTaskIndexPath(), JSON.stringify(normalizedTasks));
  return normalizedTasks;
};

const readTaskMetaFile = async (taskId: string, entryNamesPromise?: Promise<Set<string>>): Promise<RebuildChatPersistedTaskMeta | null> => {
  const entryNames = await (entryNamesPromise ?? listTaskDirEntryNames(taskId));
  if (!entryNames.has(REBUILDCHAT_TASK_META_FILE)) {
    return null;
  }

  const { content } = await readTextFile(await getTaskMetaPath(taskId));
  if (!content) {
    return null;
  }

  return normalizeRebuildChatTaskMeta(JSON.parse(content) as unknown);
};

const readTaskSourceFile = async (taskId: string, entryNamesPromise?: Promise<Set<string>>): Promise<RebuildChatPersistedTaskSourceSnapshot | null> => {
  const entryNames = await (entryNamesPromise ?? listTaskDirEntryNames(taskId));
  if (!entryNames.has(REBUILDCHAT_TASK_SOURCE_FILE)) {
    return null;
  }

  const { content } = await readTextFile(await getTaskSourcePath(taskId));
  if (!content) {
    return null;
  }

  return normalizeSourceSnapshot(JSON.parse(content) as unknown);
};

const readHistoryItems = async <TKind extends RebuildChatTaskHistoryKind>(taskId: string, kind: TKind): Promise<Array<HistoryEntryMap[TKind]>> => {
  const entryNames = await listTaskDirEntryNames(taskId);
  const historyFileName = getHistoryFileName(kind);
  if (!entryNames.has(historyFileName)) {
    return [];
  }

  const { content } = await readTextFile(await getTaskHistoryPath(taskId, kind));
  if (!content) {
    return [];
  }

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HistoryEntryMap[TKind]];
      } catch {
        return [];
      }
    });
};

const sliceHistoryItems = <TEntry>(items: TEntry[], offsetFromLatest: number, limit: number): RebuildChatTaskHistorySlice<TEntry> => {
  const totalCount = items.length;
  const safeOffset = Math.max(0, Math.min(offsetFromLatest, totalCount));
  const safeLimit = Math.max(limit, 0);
  const end = Math.max(totalCount - safeOffset, 0);
  const start = Math.max(end - safeLimit, 0);

  return {
    hasMore: start > 0,
    items: items.slice(start, end),
    limit: safeLimit,
    offsetFromLatest: safeOffset,
    totalCount,
  };
};

// eslint-disable-next-line max-len
const readHistorySlice = async <TKind extends RebuildChatTaskHistoryKind>(taskId: string, kind: TKind, offsetFromLatest: number, limit: number): Promise<RebuildChatTaskHistorySlice<HistoryEntryMap[TKind]>> => {
  const items = await readHistoryItems(taskId, kind);
  return sliceHistoryItems(items, offsetFromLatest, limit);
};

const hydrateTaskFromShards = (
  meta: RebuildChatPersistedTaskMeta,
  source: RebuildChatPersistedTaskSourceSnapshot,
  history: {
    runLogs: RebuildChatPersistedLogEntry[];
    startPromptRecords: RebuildChatPersistedStartPromptRecord[];
    turnRecords: RebuildChatPersistedTurnRecord[];
  }
): RebuildChatPersistedTask | null => {
  return (
    normalizeRebuildChatTasks([
      {
        taskId: meta.taskId,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        status: meta.status,
        source: {
          filePath: source.filePath,
          rawContent: source.rawContent,
          excludeThought: source.excludeThought,
          selectedRoles: [...source.selectedRoles],
        },
        queueSnapshot: source.queueSnapshot.map((item) => ({ ...item })),
        workDir: meta.workDir,
        watchDir: meta.watchDir,
        watchExtensionsInput: meta.watchExtensionsInput,
        includeHistoryContext: meta.includeHistoryContext,
        maxRoundsInput: meta.maxRoundsInput,
        executionErrorRetryCountInput: meta.executionErrorRetryCountInput,
        executionTimeoutMinutesInput: meta.executionTimeoutMinutesInput,
        conversationResetEveryNRoundsInput: meta.conversationResetEveryNRoundsInput,
        startPromptInput: meta.startPromptInput,
        startTurnInput: meta.startTurnInput,
        skipTurnOnNoOutput: meta.skipTurnOnNoOutput,
        stopOnNoChanges: meta.stopOnNoChanges,
        skipPermissions: meta.skipPermissions,
        reuseConversationOnManualStart: meta.reuseConversationOnManualStart,
        progress: {
          conversationId: meta.progress.conversationId,
          currentConversationRoundCount: meta.progress.currentConversationRoundCount,
          currentTurnIndex: meta.progress.currentTurnIndex,
          effectiveMaxRounds: meta.progress.effectiveMaxRounds,
          hasSentStartPromptInCurrentConversation: meta.progress.hasSentStartPromptInCurrentConversation,
          pendingStartPromptTrigger: meta.progress.pendingStartPromptTrigger,
          runEndReason: meta.progress.runEndReason,
          runLogs: history.runLogs.map((entry) => ({ ...entry })),
          startPromptRecords: history.startPromptRecords.map((entry) => ({ ...entry })),
          turnRecords: history.turnRecords.map((entry) => ({ ...entry })),
          activeTurnState: meta.progress.activeTurnState,
          retryState: meta.progress.retryState ?? null,
        },
      },
    ])[0] ?? null
  );
};

const ensureTaskHistoryFiles = async (taskId: string): Promise<void> => {
  await Promise.all([appendTextFile(await getTaskHistoryPath(taskId, 'runLogs'), ''), appendTextFile(await getTaskHistoryPath(taskId, 'turnRecords'), ''), appendTextFile(await getTaskHistoryPath(taskId, 'startPromptRecords'), '')]);
};

const readLegacyConfigTasks = async (): Promise<RebuildChatPersistedTask[]> => {
  try {
    const { content } = await readTextFile(await getLegacyConfigPath());
    if (content) {
      const parsed = decodeLegacyConfig(content);
      const tasksFromConfig = normalizeRebuildChatTasks(parsed['rebuildchat.tasks']);
      if (tasksFromConfig.length > 0) {
        return tasksFromConfig;
      }
    }
  } catch (error) {
    console.warn('[RebuildChat] Failed to read legacy task storage from config file:', error);
  }

  return ConfigStorage.get('rebuildchat.tasks')
    .then((legacyStored): RebuildChatPersistedTask[] => normalizeRebuildChatTasks(legacyStored))
    .catch((): RebuildChatPersistedTask[] => []);
};

const readLegacyTaskFile = async (fileName: string): Promise<RebuildChatPersistedTask[]> => {
  const { content } = await readTextFile(joinPath(await getCacheDir(), fileName));
  if (!content) {
    return [];
  }

  const parsed = JSON.parse(content) as unknown;
  if (Array.isArray(parsed)) {
    return normalizeRebuildChatTasks(parsed);
  }

  return normalizeRebuildChatTasks([parsed]);
};

const clearLegacyTaskStorage = async (): Promise<void> => {
  if (legacyStorageCleared) {
    return;
  }

  await ConfigStorage.set('rebuildchat.tasks', []);
  legacyStorageCleared = true;
};

const writeTaskShards = async (task: RebuildChatPersistedTask): Promise<RebuildChatPersistedTaskSummary> => {
  const meta = toRebuildChatPersistedTaskMeta(task);
  const source = toRebuildChatPersistedTaskSourceSnapshot(task);
  await Promise.all([
    writeTextFile(await getTaskMetaPath(task.taskId), JSON.stringify(meta)),
    writeTextFile(await getTaskSourcePath(task.taskId), JSON.stringify(source)),
    writeTextFile(await getTaskHistoryPath(task.taskId, 'runLogs'), task.progress.runLogs.map((entry) => JSON.stringify(entry)).join('\n') + (task.progress.runLogs.length ? '\n' : '')),
    writeTextFile(await getTaskHistoryPath(task.taskId, 'startPromptRecords'), task.progress.startPromptRecords.map((entry) => JSON.stringify(entry)).join('\n') + (task.progress.startPromptRecords.length ? '\n' : '')),
    writeTextFile(await getTaskHistoryPath(task.taskId, 'turnRecords'), task.progress.turnRecords.map((entry) => JSON.stringify(entry)).join('\n') + (task.progress.turnRecords.length ? '\n' : '')),
  ]);
  return toRebuildChatPersistedTaskSummaryFromMeta(meta);
};

const recoverTaskIndexFromTaskDirs = async (): Promise<RebuildChatPersistedTaskSummary[]> => {
  const entryNames = await listCacheEntryNames();
  const taskIds = entryNames.filter((name) => name.startsWith(REBUILDCHAT_TASK_DIR_PREFIX) && !name.endsWith('.json')).map((name) => name.slice(REBUILDCHAT_TASK_DIR_PREFIX.length));

  if (!taskIds.length) {
    return [];
  }

  const summaries = (
    await Promise.all(
      taskIds.map(async (taskId) => {
        const meta = await readTaskMetaFile(taskId);
        return meta ? toRebuildChatPersistedTaskSummaryFromMeta(meta) : null;
      })
    )
  ).filter((task): task is RebuildChatPersistedTaskSummary => Boolean(task));

  if (summaries.length) {
    await writeTaskIndexFile(summaries);
  }

  return summaries;
};

const migrateLegacyTaskStorage = async (): Promise<void> => {
  const entryNames = await listCacheEntryNames();
  const legacyFileNames = entryNames.filter((name) => LEGACY_REBUILDCHAT_TASK_BACKUP_FILE_PATTERN.test(name) || LEGACY_REBUILDCHAT_TASK_DETAIL_FILE_PATTERN.test(name));
  const hasLegacyConfigTasks = await readLegacyConfigTasks().then((tasks) => tasks.length > 0);

  if (!legacyFileNames.length && !hasLegacyConfigTasks) {
    return;
  }

  const existingIndex = await readTaskIndexFile();
  const legacyTaskGroups = await Promise.all([...legacyFileNames.map((fileName) => readLegacyTaskFile(fileName)), readLegacyConfigTasks()]);
  const mergedLegacyTasks = mergeRebuildChatTasks(...legacyTaskGroups);

  if (!mergedLegacyTasks.length) {
    await clearLegacyTaskStorage().catch(() => {});
    return;
  }

  const migratedSummaries = await Promise.all(mergedLegacyTasks.map((task) => writeTaskShards(task)));
  await writeTaskIndexFile(mergeTaskSummaries(existingIndex, migratedSummaries));

  await Promise.all(legacyFileNames.map(async (fileName) => removePathIfExists(joinPath(await getCacheDir(), fileName)).catch(() => {})));
  await clearLegacyTaskStorage().catch((error) => {
    console.error('[RebuildChat] Failed to clear legacy task storage after migration:', error);
  });
};

const ensureTaskStorageMigrated = async (): Promise<void> => {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      await migrateLegacyTaskStorage();
      const currentIndex = await readTaskIndexFile();
      if (!currentIndex.length) {
        await recoverTaskIndexFromTaskDirs();
      }
    })().catch((error) => {
      migrationPromise = null;
      throw error;
    });
  }

  await migrationPromise;
};

export const loadRebuildChatTasks = async (): Promise<RebuildChatPersistedTaskSummary[]> => {
  await ensureTaskStorageMigrated();
  return readTaskIndexFile();
};

export const loadRebuildChatTaskPreview = async (taskId: string, limits: HistoryLimitMap = {}): Promise<RebuildChatPersistedTaskPreview | null> => {
  await ensureTaskStorageMigrated();

  const entryNamesPromise = listTaskDirEntryNames(taskId);
  const [meta, source, runLogSlice, startPromptSlice, turnRecordSlice] = await Promise.all([readTaskMetaFile(taskId, entryNamesPromise), readTaskSourceFile(taskId, entryNamesPromise), readHistorySlice(taskId, 'runLogs', 0, limits.runLogs ?? 50), readHistorySlice(taskId, 'startPromptRecords', 0, limits.startPromptRecords ?? 50), readHistorySlice(taskId, 'turnRecords', 0, limits.turnRecords ?? 50)]);

  if (!meta || !source) {
    return null;
  }

  const task = hydrateTaskFromShards(meta, source, {
    runLogs: runLogSlice.items,
    startPromptRecords: startPromptSlice.items,
    turnRecords: turnRecordSlice.items,
  });

  if (!task) {
    return null;
  }

  return {
    meta,
    task,
  };
};

// eslint-disable-next-line max-len
export const loadRebuildChatTaskHistorySlice = async <TKind extends RebuildChatTaskHistoryKind>(taskId: string, kind: TKind, offsetFromLatest: number, limit: number): Promise<RebuildChatTaskHistorySlice<HistoryEntryMap[TKind]>> => {
  await ensureTaskStorageMigrated();
  return readHistorySlice(taskId, kind, offsetFromLatest, limit);
};

export const upsertRebuildChatTaskMeta = async (taskMeta: RebuildChatPersistedTaskMeta): Promise<RebuildChatPersistedTaskSummary[]> => {
  await ensureTaskStorageMigrated();

  const normalizedTaskMeta = normalizeRebuildChatTaskMeta(taskMeta);
  if (!normalizedTaskMeta) {
    throw new Error('[RebuildChat] Cannot persist invalid task meta.');
  }

  await ensureTaskHistoryFiles(normalizedTaskMeta.taskId);
  await writeTextFile(await getTaskMetaPath(normalizedTaskMeta.taskId), JSON.stringify(normalizedTaskMeta));

  const currentIndex = await readTaskIndexFile();
  const nextSummary = toRebuildChatPersistedTaskSummaryFromMeta(normalizedTaskMeta);
  const nextTasks = [nextSummary, ...currentIndex.filter((item) => item.taskId !== normalizedTaskMeta.taskId)];
  return writeTaskIndexFile(nextTasks);
};

export const replaceRebuildChatTaskSource = async (taskId: string, sourceSnapshot: RebuildChatPersistedTaskSourceSnapshot): Promise<void> => {
  await ensureTaskStorageMigrated();

  const normalizedSource = normalizeSourceSnapshot(sourceSnapshot);
  if (!normalizedSource) {
    throw new Error('[RebuildChat] Cannot persist invalid task source snapshot.');
  }

  await ensureTaskHistoryFiles(taskId);
  await writeTextFile(await getTaskSourcePath(taskId), JSON.stringify(normalizedSource));
};

const appendHistoryEntry = async <TKind extends RebuildChatTaskHistoryKind>(taskId: string, kind: TKind, entry: HistoryEntryMap[TKind]): Promise<void> => {
  await ensureTaskStorageMigrated();
  await appendTextFile(await getTaskHistoryPath(taskId, kind), `${JSON.stringify(entry)}\n`);
};

export const appendRebuildChatTaskLog = async (taskId: string, entry: RebuildChatPersistedLogEntry): Promise<void> => {
  await appendHistoryEntry(taskId, 'runLogs', entry);
};

export const appendRebuildChatTurnRecord = async (taskId: string, entry: RebuildChatPersistedTurnRecord): Promise<void> => {
  await appendHistoryEntry(taskId, 'turnRecords', entry);
};

export const appendRebuildChatStartPromptRecord = async (taskId: string, entry: RebuildChatPersistedStartPromptRecord): Promise<void> => {
  await appendHistoryEntry(taskId, 'startPromptRecords', entry);
};

export const upsertRebuildChatTask = async (task: RebuildChatPersistedTask): Promise<RebuildChatPersistedTaskSummary[]> => {
  await ensureTaskStorageMigrated();
  const normalizedTask = normalizeRebuildChatTasks([task])[0];
  if (!normalizedTask) {
    throw new Error('[RebuildChat] Cannot persist invalid task snapshot.');
  }

  const summary = await writeTaskShards(normalizedTask);
  const currentIndex = await readTaskIndexFile();
  return writeTaskIndexFile([summary, ...currentIndex.filter((item) => item.taskId !== normalizedTask.taskId)]);
};

export const loadRebuildChatTaskById = async (taskId: string): Promise<RebuildChatPersistedTask | null> => {
  const preview = await loadRebuildChatTaskPreview(taskId, {
    runLogs: Number.MAX_SAFE_INTEGER,
    startPromptRecords: Number.MAX_SAFE_INTEGER,
    turnRecords: Number.MAX_SAFE_INTEGER,
  });
  return preview?.task ?? null;
};

export const deleteRebuildChatTask = async (taskId: string): Promise<RebuildChatPersistedTaskSummary[]> => {
  await ensureTaskStorageMigrated();

  const currentIndex = await readTaskIndexFile();
  const nextTasks = currentIndex.filter((task) => task.taskId !== taskId);
  const writtenTasks = await writeTaskIndexFile(nextTasks);

  await removePathIfExists(await getTaskDirPath(taskId)).catch(() => {});
  await removePathIfExists(joinPath(await getCacheDir(), `${REBUILDCHAT_TASK_DIR_PREFIX}${taskId}.json`)).catch(() => {});
  return writtenTasks;
};

export const clearRebuildChatTasks = async (): Promise<void> => {
  await ensureTaskStorageMigrated();

  const currentIndex = await readTaskIndexFile();
  await Promise.all(currentIndex.map(async (task) => removePathIfExists(await getTaskDirPath(task.taskId)).catch(() => {})));

  const entryNames = await listCacheEntryNames();
  await Promise.all(entryNames.filter((name) => (name.startsWith(REBUILDCHAT_TASK_DIR_PREFIX) && !name.endsWith('.json')) || LEGACY_REBUILDCHAT_TASK_BACKUP_FILE_PATTERN.test(name) || LEGACY_REBUILDCHAT_TASK_DETAIL_FILE_PATTERN.test(name)).map(async (name) => removePathIfExists(joinPath(await getCacheDir(), name)).catch(() => {})));

  await writeTaskIndexFile([]);
  await clearLegacyTaskStorage().catch((error) => {
    console.error('[RebuildChat] Failed to clear legacy task storage while clearing all tasks:', error);
  });
};
