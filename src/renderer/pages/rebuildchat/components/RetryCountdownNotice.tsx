import type { RebuildChatPersistedRetryState } from '@/common/rebuildchat/persistedTask';
import React, { useEffect, useState } from 'react';
import styles from '../index.module.css';
import { formatRetryClock, formatRetryDelay, formatRetryRemaining, getRetryPhaseLabel } from '../viewLabels';

const RetryCountdownNotice: React.FC<{
  currentTurnIndex: number;
  retryState: RebuildChatPersistedRetryState;
}> = ({ currentTurnIndex, retryState }) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (retryState.retryAt === null) {
      return;
    }

    setNow(Date.now());
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [retryState.retryAt]);

  const retrySummaryText = retryState.retryAt === null ? `${getRetryPhaseLabel(retryState.phase)}因额度限制暂停，按固定间隔 ${formatRetryDelay(retryState.retryDelayMs)} 自动重试。` : `${getRetryPhaseLabel(retryState.phase)}因额度限制暂停，将在 ${formatRetryClock(retryState.retryAt)} 自动重试，剩余约 ${formatRetryRemaining(retryState.retryAt, now)}。`;

  return (
    <div className={styles.waitNotice} data-testid='run-retry-waiting'>
      <div>额度等待：{retrySummaryText}</div>
      <div>
        恢复方式：继续当前会话，
        {retryState.phase === 'start_prompt' ? `重发第 ${(retryState.resumeTurnIndex ?? currentTurnIndex) + 1} 轮前的起始 prompt。` : `重发第 ${(retryState.resumeTurnIndex ?? currentTurnIndex) + 1} 轮。`}
      </div>
      {retryState.lastMatchedMessage ? <div>最近提示：{retryState.lastMatchedMessage}</div> : null}
    </div>
  );
};

export default RetryCountdownNotice;
