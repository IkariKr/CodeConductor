import { hasFileChanges, type FileChangeSummary } from './fileChangeTracker';

export type RunStatus = 'idle' | 'running' | 'paused' | 'stopping' | 'completed' | 'failed';
export type RunEndReason = 'all_sent' | 'max_rounds' | 'no_output' | 'aborted' | 'failed' | null;
export type RunLogKind = 'system' | 'turn' | 'output';
export type TurnStatus = 'completed' | 'failed' | 'aborted';

export interface RebuildChatQueueEntry {
  role: string;
  text: string;
}

export interface RebuildChatTurnRecord {
  turnNumber: number;
  role: string;
  prompt: string;
  output: string;
  status: TurnStatus;
  conversationId: string | null;
  fileChanges: FileChangeSummary;
}

export interface RebuildChatControl {
  consumePauseRequest?: () => boolean;
  isAbortRequested: () => boolean;
  isPauseRequested: () => boolean;
}

export interface RebuildChatExecuteTurnResult {
  conversationId: string | null;
  exitCode: number | null;
  fileChanges: FileChangeSummary;
  output: string;
}

export interface RebuildChatExecuteTurnParams {
  conversationId: string | null;
  prompt: string;
  queueItem: RebuildChatQueueEntry;
  turnIndex: number;
  turnNumber: number;
}

export interface ExecuteRebuildChatRunOptions {
  control: RebuildChatControl;
  executeTurn: (params: RebuildChatExecuteTurnParams) => Promise<RebuildChatExecuteTurnResult>;
  includeHistoryContext: boolean;
  initialConversationId?: string | null;
  maxRounds: number;
  onConversationId?: (conversationId: string) => void;
  onCurrentTurnIndex?: (turnIndex: number) => void;
  onLog?: (kind: RunLogKind, text: string) => void;
  onTurnRecord?: (record: RebuildChatTurnRecord) => void;
  queue: RebuildChatQueueEntry[];
  startIndex?: number;
  stopOnNoChanges: boolean;
}

export interface ExecuteRebuildChatRunResult {
  conversationId: string | null;
  endReason: RunEndReason;
  nextTurnIndex: number;
  status: Exclude<RunStatus, 'idle' | 'running' | 'stopping'>;
}

export const formatQueueEntryPrompt = (item: RebuildChatQueueEntry, index: number): string => {
  return [`第 ${index + 1} 条`, `role: ${item.role}`, '', item.text].join('\n');
};

export const buildPromptForTurn = (queue: RebuildChatQueueEntry[], index: number, includeHistory: boolean): string => {
  if (!includeHistory || index === 0) {
    return formatQueueEntryPrompt(queue[index], index);
  }

  return queue
    .slice(0, index + 1)
    .map((item, entryIndex) => formatQueueEntryPrompt(item, entryIndex))
    .join('\n\n---\n\n');
};

export const summarizeFileChanges = (summary: FileChangeSummary): string => {
  const parts = [`新增 ${summary.created.length}`, `修改 ${summary.updated.length}`, `删除 ${summary.deleted.length}`];
  return parts.join(' / ');
};

export const executeRebuildChatRun = async (options: ExecuteRebuildChatRunOptions): Promise<ExecuteRebuildChatRunResult> => {
  let conversationId = options.initialConversationId ?? null;
  let activeTurnIndex = options.startIndex ?? 0;

  try {
    for (let index = options.startIndex ?? 0; index < options.queue.length; index += 1) {
      activeTurnIndex = index;

      if (index >= options.maxRounds) {
        options.onLog?.('system', `已达到最大轮数 ${options.maxRounds}。`);
        return {
          conversationId,
          endReason: 'max_rounds',
          nextTurnIndex: index,
          status: 'completed',
        };
      }

      if (options.control.isAbortRequested()) {
        options.onLog?.('system', '运行已被中止。');
        return {
          conversationId,
          endReason: 'aborted',
          nextTurnIndex: index,
          status: 'completed',
        };
      }

      const item = options.queue[index];
      const prompt = buildPromptForTurn(options.queue, index, options.includeHistoryContext);
      const turnNumber = index + 1;

      options.onCurrentTurnIndex?.(index);
      options.onLog?.('turn', `第 ${turnNumber} 轮开始，role=${item.role}`);

      const result = await options.executeTurn({
        conversationId,
        prompt,
        queueItem: item,
        turnIndex: index,
        turnNumber,
      });

      if (result.conversationId) {
        conversationId = result.conversationId;
        options.onConversationId?.(result.conversationId);
      }

      const wasAborted = options.control.isAbortRequested();
      const turnStatus: TurnStatus = wasAborted ? 'aborted' : result.exitCode === 0 ? 'completed' : 'failed';

      options.onTurnRecord?.({
        turnNumber,
        role: item.role,
        prompt,
        output: result.output,
        status: turnStatus,
        conversationId,
        fileChanges: result.fileChanges,
      });

      options.onLog?.('output', `第 ${turnNumber} 轮输出：${result.output || '(空输出)'}`);
      options.onLog?.('system', `第 ${turnNumber} 轮文件变化：${summarizeFileChanges(result.fileChanges)}`);

      if (wasAborted) {
        return {
          conversationId,
          endReason: 'aborted',
          nextTurnIndex: turnNumber,
          status: 'completed',
        };
      }

      if (result.exitCode !== 0) {
        options.onLog?.('system', `第 ${turnNumber} 轮失败，退出码：${result.exitCode ?? 'null'}。`);
        return {
          conversationId,
          endReason: 'failed',
          nextTurnIndex: turnNumber,
          status: 'failed',
        };
      }

      if (options.stopOnNoChanges && !hasFileChanges(result.fileChanges)) {
        options.onLog?.('system', `第 ${turnNumber} 轮未检测到文件产出，按规则自动停止。`);
        return {
          conversationId,
          endReason: 'no_output',
          nextTurnIndex: turnNumber,
          status: 'completed',
        };
      }

      const nextIndex = turnNumber;
      options.onCurrentTurnIndex?.(nextIndex);
      const shouldPause = options.control.consumePauseRequest ? options.control.consumePauseRequest() : options.control.isPauseRequested();
      if (shouldPause) {
        options.onLog?.('system', `已在第 ${turnNumber} 轮后暂停。`);
        return {
          conversationId,
          endReason: null,
          nextTurnIndex: nextIndex,
          status: 'paused',
        };
      }
    }

    options.onLog?.('system', '队列全部发送完成。');
    return {
      conversationId,
      endReason: 'all_sent',
      nextTurnIndex: options.queue.length,
      status: 'completed',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.onLog?.('system', `运行异常：${message}`);
    return {
      conversationId,
      endReason: 'failed',
      nextTurnIndex: activeTurnIndex,
      status: 'failed',
    };
  }
};
