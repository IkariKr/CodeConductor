import { ipcBridge } from '@/common';
import { executeRebuildChatRun, summarizeFileChanges, type RebuildChatTurnRecord, type RunEndReason, type RunLogKind, type RunStatus } from '@/common/rebuildchat/rebuildChatExecutor';
import { appendCustomPromptQueueItem, createEditablePromptQueue, removeEditablePromptQueueItems, updateEditablePromptQueueItem, type EditablePromptQueueItem } from '@/common/rebuildchat/editablePromptQueue';
import { parsePromptFile, type ParsePromptFileResult } from '@/common/rebuildchat/promptFileParser';
import { parseError, uuid } from '@/common/utils';
import { Button, Card, Checkbox, Empty, Input, Message, Space, Switch, Tag, Typography } from '@arco-design/web-react';
import { CloseOne, Delete, Pause, Play, Plus, Refresh, Right, UploadOne } from '@icon-park/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { getRebuildChatRuntimeDriver } from './runtime';
import styles from './index.module.css';

const { Paragraph, Text } = Typography;

interface RunLogEntry {
  id: string;
  kind: RunLogKind;
  text: string;
  timestamp: string;
}

interface TurnRecord extends RebuildChatTurnRecord {
  id: string;
}

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
  getState: () => {
    conversationId: string | null;
    currentTurnIndex: number;
    queueLength: number;
    runEndReason: RunEndReason;
    runLogCount: number;
    runStatus: RunStatus;
    turnRecordCount: number;
    watchDir: string;
    workDir: string;
  };
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

  const queueRef = useRef(queue);
  const currentExecutionRef = useRef<Awaited<ReturnType<ReturnType<typeof getRebuildChatRuntimeDriver>['startAgyPrintTurn']>> | null>(null);
  const pauseRequestedRef = useRef(false);
  const abortRequestedRef = useRef(false);

  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

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
    setQueue(createEditablePromptQueue(filteredChunks));
    setSelectedQueueIds([]);
    setCurrentTurnIndex(0);
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
    const parsed = Number(maxRoundsInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return queue.length;
    }
    return Math.min(queue.length, Math.floor(parsed));
  }, [maxRoundsInput, queue.length]);

  const appendRunLog = (kind: RunLogKind, text: string) => {
    setRunLogs((previous) => [
      ...previous,
      {
        id: `log-${uuid(12)}`,
        kind,
        text,
        timestamp: new Date().toLocaleTimeString(),
      },
    ]);
  };

  const applyPromptFileSelection = (nextPath: string, nextContent: string, nextWorkDir?: string, nextWatchDir?: string) => {
    const nextParentDir = getRebuildChatRuntimeDriver().getParentDirectory(nextPath);

    setFilePath(nextPath);
    setRawContent(nextContent);
    setErrorText('');
    setWorkDir((previous) => nextWorkDir || previous || nextParentDir);
    setWatchDir((previous) => nextWatchDir || previous || nextParentDir);
  };

  const seedPromptFileForTestApi = (payload: RebuildChatSeedPromptFilePayload) => {
    const { filePath: nextPath, rawContent: nextContent, workDir: nextWorkDir, watchDir: nextWatchDir } = payload;
    applyPromptFileSelection(nextPath, nextContent, nextWorkDir, nextWatchDir);
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
    currentExecutionRef.current = null;
    setRunStatus(status);
    setRunEndReason(reason);
    if (typeof nextTurnIndex === 'number') {
      setCurrentTurnIndex(nextTurnIndex);
    }
  };

  useEffect(() => {
    window.__REBUILDCHAT_TEST_API__ = {
      seedPromptFile: seedPromptFileForTestApi,
      setRunConfig: setRunConfigForTestApi,
      getState: () => ({
        conversationId,
        currentTurnIndex,
        queueLength: queueRef.current.length,
        runEndReason,
        runLogCount: runLogs.length,
        runStatus,
        turnRecordCount: turnRecords.length,
        watchDir,
        workDir,
      }),
    };

    return () => {
      delete window.__REBUILDCHAT_TEST_API__;
    };
  }, [conversationId, currentTurnIndex, runEndReason, runLogs.length, runStatus, turnRecords.length, watchDir, workDir]);

  const executeQueue = async (startIndex: number, initialConversationId: string | null) => {
    const runtime = getRebuildChatRuntimeDriver();
    const result = await executeRebuildChatRun({
      queue: queueRef.current,
      startIndex,
      initialConversationId,
      includeHistoryContext,
      maxRounds: effectiveMaxRounds,
      stopOnNoChanges,
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
        const beforeSnapshot = watchDir ? await runtime.snapshotDirectory(watchDir, watchExtensionsInput) : {};
        const execution = await runtime.startAgyPrintTurn({
          prompt,
          cwd: workDir,
          conversationId: activeConversationId,
          skipPermissions,
        });
        currentExecutionRef.current = execution;
        const turnResult = await execution.promise;
        currentExecutionRef.current = null;
        const afterSnapshot = watchDir ? await runtime.snapshotDirectory(watchDir, watchExtensionsInput) : {};
        const fileChanges = runtime.compareDirectorySnapshots(beforeSnapshot, afterSnapshot);

        return {
          conversationId: turnResult.conversationId ?? activeConversationId,
          exitCode: turnResult.exitCode,
          output: turnResult.output,
          fileChanges,
        };
      },
      onConversationId: (nextConversationId) => {
        setConversationId(nextConversationId);
      },
      onCurrentTurnIndex: (turnIndex) => {
        setCurrentTurnIndex(turnIndex);
      },
      onLog: appendRunLog,
      onTurnRecord: (record) => {
        setTurnRecords((previous) => [
          ...previous,
          {
            ...record,
            id: `turn-${uuid(12)}`,
          },
        ]);
      },
    });

    finishRun(result.status, result.endReason, result.nextTurnIndex);
  };

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
      applyPromptFileSelection(nextPath, nextContent);
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
    if (!queue.length) {
      Message.warning('当前没有可发送的队列内容。');
      return;
    }

    if (!workDir) {
      Message.warning('请先选择 agy 工作目录。');
      return;
    }

    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    setRunLogs([]);
    setTurnRecords([]);
    setConversationId(null);
    setCurrentTurnIndex(0);
    setRunEndReason(null);
    setRunStatus('running');
    appendRunLog('system', '开始新一轮运行。');
    void executeQueue(0, null);
  };

  const handlePause = () => {
    if (runStatus !== 'running') return;
    pauseRequestedRef.current = true;
    setRunStatus('stopping');
    appendRunLog('system', '已请求暂停，将在当前轮完成后停下。');
  };

  const handleResume = () => {
    if (runStatus !== 'paused') return;
    pauseRequestedRef.current = false;
    abortRequestedRef.current = false;
    setRunEndReason(null);
    setRunStatus('running');
    appendRunLog('system', `从第 ${currentTurnIndex + 1} 轮继续运行。`);
    void executeQueue(currentTurnIndex, conversationId);
  };

  const handleAbort = async () => {
    if (runStatus === 'paused') {
      appendRunLog('system', '已在暂停状态下中止本次运行。');
      finishRun('completed', 'aborted', currentTurnIndex);
      return;
    }

    if (runStatus !== 'running' && runStatus !== 'stopping') return;

    abortRequestedRef.current = true;
    setRunStatus('stopping');
    appendRunLog('system', '正在中止当前运行。');
    try {
      await currentExecutionRef.current?.abort();
    } catch (error) {
      appendRunLog('system', `中止进程时出错：${getRebuildChatRuntimeDriver().formatRuntimeError(error)}`);
    }
  };

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
              <div className={styles.panelTitle}>1. 输入区</div>
              <div className={styles.panelDesc}>先选文件，再确认过滤条件。切换过滤条件会重建待发送队列。</div>

              <Space direction='vertical' size={16} style={{ width: '100%', marginTop: 16 }}>
                <Space wrap>
                  <Button data-testid='pick-json-file' type='primary' icon={<UploadOne theme='outline' size='18' fill='currentColor' />} loading={loading} onClick={handlePickFile}>
                    选择 JSON 文件
                  </Button>
                  <Button data-testid='reload-json-file' icon={<Refresh theme='outline' size='18' fill='currentColor' />} disabled={!filePath || loading} onClick={handleReload}>
                    重新读取
                  </Button>
                </Space>

                <div className={styles.pathBox}>{filePath || '还没有选择文件。'}</div>

                <div>
                  <Text style={{ display: 'block', marginBottom: 8 }}>默认过滤 thought</Text>
                  <Switch checked={excludeThought} onChange={(checked) => setExcludeThought(checked)} />
                </div>

                <div>
                  <Text style={{ display: 'block', marginBottom: 8 }}>role 多选</Text>
                  <div className={styles.roleWrap}>
                    {(parseResult?.availableRoles || []).map((role) => {
                      const checked = selectedRoles.includes(role);
                      return (
                        <Tag key={role} checkable checked={checked} onCheck={() => toggleRole(role)} color={checked ? 'blue' : undefined}>
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
                    <Input value={workDir} placeholder='选择 agy 运行目录' onChange={setWorkDir} />
                    <Button onClick={() => void pickDirectory(setWorkDir)}>选目录</Button>
                  </div>
                </div>

                <div>
                  <Text style={{ display: 'block', marginBottom: 8 }}>产出监控目录</Text>
                  <div className={styles.inlinePicker}>
                    <Input value={watchDir} placeholder='选择要监控的目录' onChange={setWatchDir} />
                    <Button onClick={() => void pickDirectory(setWatchDir)}>选目录</Button>
                  </div>
                </div>

                <div className={styles.configGrid}>
                  <div>
                    <Text style={{ display: 'block', marginBottom: 8 }}>监控后缀</Text>
                    <Input value={watchExtensionsInput} placeholder='.md,.ts,.json，留空表示全部' onChange={setWatchExtensionsInput} />
                  </div>
                  <div>
                    <Text style={{ display: 'block', marginBottom: 8 }}>最大轮数</Text>
                    <Input value={maxRoundsInput} placeholder='留空表示跑完整个队列' onChange={setMaxRoundsInput} />
                  </div>
                </div>

                <div className={styles.toggleGrid}>
                  <div className={styles.toggleRow}>
                    <div>
                      <div className={styles.toggleTitle}>第二轮起拼接历史</div>
                      <div className={styles.roleHint}>关闭时每轮只发当前条目，开启时会把前面条目一起拼进 prompt。</div>
                    </div>
                    <Switch checked={includeHistoryContext} onChange={(checked) => setIncludeHistoryContext(checked)} />
                  </div>

                  <div className={styles.toggleRow}>
                    <div>
                      <div className={styles.toggleTitle}>无产出自动停止</div>
                      <div className={styles.roleHint}>如果本轮前后目录快照没有新增 / 修改 / 删除，就结束运行。</div>
                    </div>
                    <Switch checked={stopOnNoChanges} onChange={(checked) => setStopOnNoChanges(checked)} />
                  </div>

                  <div className={styles.toggleRow}>
                    <div>
                      <div className={styles.toggleTitle}>自动跳过权限确认</div>
                      <div className={styles.roleHint}>会追加 `--dangerously-skip-permissions`，适合内部环境快速跑通，但风险更高。</div>
                    </div>
                    <Switch checked={skipPermissions} onChange={(checked) => setSkipPermissions(checked)} />
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
                  <Button data-testid='queue-add-custom' type='primary' icon={<Plus theme='outline' size='18' fill='currentColor' />} onClick={handleAddCustom} disabled={runStatus === 'running' || runStatus === 'stopping'}>
                    新增自定义条目
                  </Button>
                  <Button data-testid='queue-delete-selected' status='danger' icon={<Delete theme='outline' size='18' fill='currentColor' />} disabled={!selectedQueueIds.length || runStatus === 'running' || runStatus === 'stopping'} onClick={handleDeleteSelected}>
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
                            <Checkbox checked={selectedQueueIds.includes(item.id)} disabled={runStatus === 'running' || runStatus === 'stopping'} onChange={() => toggleQueueSelection(item.id)} />
                            <Text bold>第 {index + 1} 条</Text>
                            <div className={styles.queueMeta}>
                              {item.isCustom ? <Tag color='green'>自定义</Tag> : <Tag color='blue'>提取项</Tag>}
                              {item.edited ? <Tag color='orange'>已编辑</Tag> : <Tag>原始</Tag>}
                              {item.sourceIndex !== null ? <Tag color='gray'>source #{item.sourceIndex + 1}</Tag> : null}
                              {item.tokenCount !== null ? <Tag color='gray'>{item.tokenCount} tokens</Tag> : null}
                            </div>
                          </div>
                          <Button size='small' status='danger' disabled={runStatus === 'running' || runStatus === 'stopping'} onClick={() => handleDeleteSingle(item.id)}>
                            删除
                          </Button>
                        </div>

                        <div className={styles.queueRow}>
                          <Input value={item.role} disabled={runStatus === 'running' || runStatus === 'stopping'} placeholder='role' onChange={(value) => handleQueueChange(item.id, { role: value })} />
                          <Input.TextArea value={item.text} disabled={runStatus === 'running' || runStatus === 'stopping'} placeholder='输入要发送给 agy 的文本' autoSize={{ minRows: 3, maxRows: 12 }} onChange={(value) => handleQueueChange(item.id, { text: value })} />
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

                <Space wrap>
                  <Button data-testid='run-start' type='primary' icon={<Play theme='outline' size='18' fill='currentColor' />} disabled={runStatus === 'running' || runStatus === 'stopping' || !queue.length} onClick={handleStart}>
                    开始
                  </Button>
                  <Button data-testid='run-pause' icon={<Pause theme='outline' size='18' fill='currentColor' />} disabled={runStatus !== 'running'} onClick={handlePause}>
                    暂停
                  </Button>
                  <Button data-testid='run-resume' icon={<Right theme='outline' size='18' fill='currentColor' />} disabled={runStatus !== 'paused'} onClick={handleResume}>
                    继续
                  </Button>
                  <Button data-testid='run-abort' status='danger' icon={<CloseOne theme='outline' size='18' fill='currentColor' />} disabled={runStatus !== 'running' && runStatus !== 'stopping' && runStatus !== 'paused'} onClick={() => void handleAbort()}>
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
