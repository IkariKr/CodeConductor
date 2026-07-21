import type { RebuildChatPersistedStartPromptRecord, RebuildChatPersistedTurnRecord } from '@/common/rebuildchat/persistedTask';
import { summarizeFileChanges } from '@/common/rebuildchat/rebuildChatExecutor';
import { Button, Empty, Tag } from '@arco-design/web-react';
import React from 'react';
import styles from '../index.module.css';

interface ObservePanelProps {
  startPromptRecords: RebuildChatPersistedStartPromptRecord[];
  startPromptLoadedCount: number;
  startPromptTotalCount: number;
  turnRecords: RebuildChatPersistedTurnRecord[];
  turnLoadedCount: number;
  turnTotalCount: number;
  startPromptLoading: boolean;
  turnRecordLoading: boolean;
  onLoadOlderStartPrompts: (loadAll?: boolean) => void;
  onLoadOlderTurnRecords: (loadAll?: boolean) => void;
}

const ObservePanel: React.FC<ObservePanelProps> = ({ startPromptRecords, startPromptLoadedCount, startPromptTotalCount, turnRecords, turnLoadedCount, turnTotalCount, startPromptLoading, turnRecordLoading, onLoadOlderStartPrompts, onLoadOlderTurnRecords }) => {
  return (
    <section className={`${styles.panel} ${styles.panelGrow}`}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>观察区</div>
        <div className={styles.panelDesc}>每轮都会记录 prompt、agy 输出摘要、文件变化摘要和状态，方便后续做联调与验收。</div>
      </div>

      <div className={`${styles.panelBody} ${styles.panelBodyGrow}`}>
        {startPromptRecords.length ? (
          <>
            <div className={styles.turnRecordList} data-testid='start-prompt-record-list'>
              {startPromptRecords.map((record) => (
                <div key={record.id} className={styles.turnRecordCard} data-testid='start-prompt-record-card'>
                  <div className={styles.turnRecordHeader}>
                    <span className={styles.turnRecordTitle}>起始 prompt</span>
                    <div className={styles.queueMeta}>
                      <Tag color='blue'>{record.trigger === 'task_start' ? '任务开始' : '会话重置'}</Tag>
                      <Tag color={record.status === 'completed' ? 'green' : record.status === 'aborted' ? 'orange' : 'red'}>{record.status}</Tag>
                      <Tag color='gray'>目标第 {record.targetTurnIndex + 1} 轮</Tag>
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
                </div>
              ))}
            </div>
            {startPromptLoadedCount < startPromptTotalCount ? (
              <div className={styles.historyActions}>
                <Button size='small' loading={startPromptLoading} onClick={() => onLoadOlderStartPrompts()}>
                  再加载 50 条
                </Button>
                <Button size='small' disabled={startPromptLoading} onClick={() => onLoadOlderStartPrompts(true)}>
                  查看全部
                </Button>
                <div className={styles.historyHint}>
                  已加载 {startPromptLoadedCount} / {startPromptTotalCount} 条起始记录
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {turnRecords.length ? (
          <>
            <div className={styles.turnRecordList} data-testid='turn-record-list'>
              {turnRecords.map((record) => (
                <div key={record.id} className={styles.turnRecordCard} data-testid='turn-record-card'>
                  <div className={styles.turnRecordHeader}>
                    <span className={styles.turnRecordTitle}>第 {record.turnNumber} 轮</span>
                    <div className={styles.queueMeta}>
                      <Tag color='blue'>{record.role}</Tag>
                      <Tag color={record.status === 'completed' ? 'green' : record.status === 'skipped' ? 'gold' : record.status === 'aborted' ? 'orange' : 'red'}>{record.status}</Tag>
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
                    <div className={styles.fieldHint}>{summarizeFileChanges(record.fileChanges)}</div>
                  </div>
                </div>
              ))}
            </div>
            {turnLoadedCount < turnTotalCount ? (
              <div className={styles.historyActions}>
                <Button size='small' loading={turnRecordLoading} onClick={() => onLoadOlderTurnRecords()}>
                  再加载 50 条
                </Button>
                <Button size='small' disabled={turnRecordLoading} onClick={() => onLoadOlderTurnRecords(true)}>
                  查看全部
                </Button>
                <div className={styles.historyHint}>
                  已加载 {turnLoadedCount} / {turnTotalCount} 条观察记录
                </div>
              </div>
            ) : null}
          </>
        ) : !startPromptRecords.length ? (
          <div className={styles.emptyBox}>
            <Empty description='开始运行后，这里会记录每一轮的输入、输出和文件变化。' />
          </div>
        ) : null}
      </div>
    </section>
  );
};

export default ObservePanel;
