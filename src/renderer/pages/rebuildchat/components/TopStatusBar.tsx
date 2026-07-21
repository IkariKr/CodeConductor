import type { RunEndReason, RunStatus } from '@/common/rebuildchat/rebuildChatExecutor';
import { Button } from '@arco-design/web-react';
import { CloseOne, Pause, Play, Right, SettingTwo } from '@icon-park/react';
import React from 'react';
import styles from '../index.module.css';
import { getEndReasonLabel } from '../viewLabels';

const STATUS_TONE_CLASS: Record<string, string> = {
  running: styles.statusToneRunning,
  stopping: styles.statusToneStopping,
  paused: styles.statusTonePaused,
  waiting_retry: styles.statusToneWaiting,
  completed: styles.statusToneCompleted,
  failed: styles.statusToneFailed,
  aborted: styles.statusToneFailed,
};

interface TopStatusBarProps {
  runStatus: RunStatus;
  runEndReason: RunEndReason;
  nextTurnNumber: number;
  conversationId: string | null;
  effectiveMaxRounds: number;
  startDisabled: boolean;
  pauseDisabled: boolean;
  resumeDisabled: boolean;
  abortDisabled: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onAbort: () => void;
  onOpenConfig: () => void;
}

const TopStatusBar: React.FC<TopStatusBarProps> = ({ runStatus, runEndReason, nextTurnNumber, conversationId, effectiveMaxRounds, startDisabled, pauseDisabled, resumeDisabled, abortDisabled, onStart, onPause, onResume, onAbort, onOpenConfig }) => {
  const statusToneClass = STATUS_TONE_CLASS[runStatus] ?? styles.statusToneIdle;

  return (
    <header className={styles.topBar}>
      <div className={styles.topBarBrand}>
        <div className={styles.topBarTitle}>RebuildChat 首板工作台</div>
        <div className={styles.topBarSubtitle}>固定 Agent：agy · Step 6-8</div>
      </div>

      <div className={styles.topBarStatusGroup}>
        <div className={`${styles.topStat} ${statusToneClass}`} data-testid='run-status-card'>
          <span className={styles.statusDot} />
          <div className={styles.topStatBody}>
            <div className={styles.topStatLabel}>当前状态</div>
            <div className={styles.topStatValue} data-testid='run-status-value'>
              {runStatus}
            </div>
          </div>
        </div>

        <div className={styles.topStat}>
          <div className={styles.topStatBody}>
            <div className={styles.topStatLabel}>下一轮</div>
            <div className={styles.topStatValue}>{nextTurnNumber}</div>
          </div>
        </div>

        <div className={styles.topStat} data-testid='run-end-reason-card'>
          <div className={styles.topStatBody}>
            <div className={styles.topStatLabel}>结束原因</div>
            <div className={styles.topStatValueSmall} data-testid='run-end-reason-value'>
              {getEndReasonLabel(runEndReason)}
            </div>
          </div>
        </div>

        <div className={`${styles.topStat} ${styles.topStatWide}`} data-testid='conversation-id-box'>
          <div className={styles.topStatBody}>
            <div className={styles.topStatLabel}>conversationId</div>
            <div className={styles.topStatValueMono}>{conversationId || '还没有拿到 agy 会话 ID。'}</div>
          </div>
        </div>

        <div className={styles.topStat} data-testid='effective-max-rounds-box'>
          <div className={styles.topStatBody}>
            <div className={styles.topStatLabel}>有效最大轮数</div>
            <div className={styles.topStatValue}>{effectiveMaxRounds || 0}</div>
          </div>
        </div>
      </div>

      <div className={styles.topBarActions}>
        <Button data-testid='run-start' type='primary' icon={<Play theme='outline' size='16' fill='currentColor' />} disabled={startDisabled} onClick={onStart}>
          开始
        </Button>
        <Button data-testid='run-pause' icon={<Pause theme='outline' size='16' fill='currentColor' />} disabled={pauseDisabled} onClick={onPause}>
          暂停
        </Button>
        <Button data-testid='run-resume' icon={<Right theme='outline' size='16' fill='currentColor' />} disabled={resumeDisabled} onClick={onResume}>
          继续
        </Button>
        <Button data-testid='run-abort' status='danger' icon={<CloseOne theme='outline' size='16' fill='currentColor' />} disabled={abortDisabled} onClick={onAbort}>
          中止
        </Button>
        <Button className={styles.configButton} icon={<SettingTwo theme='outline' size='16' fill='currentColor' />} onClick={onOpenConfig}>
          运行配置
        </Button>
      </div>
    </header>
  );
};

export default TopStatusBar;
