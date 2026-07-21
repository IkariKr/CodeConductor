import type { RebuildChatPersistedLogEntry } from '@/common/rebuildchat/persistedTask';
import { Button } from '@arco-design/web-react';
import React from 'react';
import styles from '../index.module.css';

interface RunLogPanelProps {
  runLogs: RebuildChatPersistedLogEntry[];
  totalCount: number;
  loading: boolean;
  conversationResetPreviewText: string;
  startTurnPreviewText: string;
  onLoadOlder: (loadAll?: boolean) => void;
}

const RunLogPanel: React.FC<RunLogPanelProps> = ({ runLogs, totalCount, loading, conversationResetPreviewText, startTurnPreviewText, onLoadOlder }) => {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>运行日志</div>
        <div className={styles.panelDesc}>顺序发送、持续会话、暂停 / 继续 / 中止、按目录快照判断产出。</div>
      </div>

      <div className={styles.panelBody}>
        {conversationResetPreviewText ? <div className={styles.hintBox}>{conversationResetPreviewText}</div> : null}
        {startTurnPreviewText ? <div className={styles.hintBox}>{startTurnPreviewText}</div> : null}

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

        {runLogs.length < totalCount ? (
          <div className={styles.historyActions}>
            <Button size='small' loading={loading} onClick={() => onLoadOlder()}>
              再加载 50 条
            </Button>
            <Button size='small' disabled={loading} onClick={() => onLoadOlder(true)}>
              查看全部
            </Button>
            <div className={styles.historyHint}>
              已加载 {runLogs.length} / {totalCount} 条日志
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
};

export default RunLogPanel;
