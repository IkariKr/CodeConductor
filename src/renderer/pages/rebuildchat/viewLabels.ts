import { getRebuildChatTaskResumeIndex, type RebuildChatPersistedTaskStatus, type RebuildChatPersistedTaskSummary, type RebuildChatRetryPhase } from '@/common/rebuildchat/persistedTask';
import type { RunEndReason } from '@/common/rebuildchat/rebuildChatExecutor';

export const getEndReasonLabel = (reason: RunEndReason): string => {
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

export const getTaskStatusLabel = (status: RebuildChatPersistedTaskStatus): string => {
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

export const getTaskTitle = (task: RebuildChatPersistedTaskSummary): string => {
  const normalizedPath = task.source.filePath.replace(/\\/g, '/');
  const segments = normalizedPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || `任务 ${task.taskId.slice(0, 8)}`;
};

export const getTaskProgressLabel = (task: RebuildChatPersistedTaskSummary): string => {
  const nextTurn = Math.min(getRebuildChatTaskResumeIndex(task) + 1, Math.max(task.queueLength, 1));
  const totalTurns = Math.max(task.progress.effectiveMaxRounds || task.queueLength, 0);
  return `第 ${nextTurn} / ${totalTurns}`;
};

export const getRetryPhaseLabel = (phase: RebuildChatRetryPhase | undefined): string => {
  return phase === 'start_prompt' ? '起始 prompt' : '当前轮';
};

export const formatRetryDelay = (delayMs: number): string => {
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

export const formatRetryClock = (retryAt: number | null): string => {
  if (retryAt === null) {
    return '待定';
  }

  return new Date(retryAt).toLocaleTimeString();
};

export const formatRetryRemaining = (retryAt: number | null, now: number): string => {
  if (retryAt === null) {
    return '按固定间隔等待';
  }

  return formatRetryDelay(Math.max(retryAt - now, 0));
};
