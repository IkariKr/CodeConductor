import type { EditablePromptQueueItem } from '@/common/rebuildchat/editablePromptQueue';
import { Button, Checkbox, Empty, Input, Tag } from '@arco-design/web-react';
import { Delete, Plus } from '@icon-park/react';
import React from 'react';
import styles from '../index.module.css';

interface QueueStats {
  customCount: number;
  editedCount: number;
  total: number;
}

interface QueueEditorPanelProps {
  queue: EditablePromptQueueItem[];
  selectedQueueIds: string[];
  disabled: boolean;
  hasParseResult: boolean;
  stats: QueueStats;
  onToggleSelection: (id: string) => void;
  onDeleteSelected: () => void;
  onDeleteSingle: (id: string) => void;
  onAddCustom: () => void;
  onQueueChange: (id: string, updates: { role?: string; text?: string }) => void;
}

const QueueEditorPanel: React.FC<QueueEditorPanelProps> = ({ queue, selectedQueueIds, disabled, hasParseResult, stats, onToggleSelection, onDeleteSelected, onDeleteSingle, onAddCustom, onQueueChange }) => {
  return (
    <section className={`${styles.panel} ${styles.panelGrow}`}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitleRow}>
          <div>
            <div className={styles.panelTitle}>编辑队列</div>
            <div className={styles.panelDesc}>发送队列来自当前过滤结果。可新增自定义条目，或对条目勾选删除和文本修改。</div>
          </div>
          <div className={styles.buttonRow}>
            <Button data-testid='queue-add-custom' type='primary' size='small' icon={<Plus theme='outline' size='16' fill='currentColor' />} onClick={onAddCustom} disabled={disabled}>
              新增自定义条目
            </Button>
            <Button data-testid='queue-delete-selected' status='danger' size='small' icon={<Delete theme='outline' size='16' fill='currentColor' />} disabled={!selectedQueueIds.length || disabled} onClick={onDeleteSelected}>
              删除选中项
            </Button>
          </div>
        </div>
      </div>

      <div className={`${styles.panelBody} ${styles.panelBodyGrow}`}>
        <div className={styles.notice}>切换 role 或 thought 过滤开关时，会按当前规则重新生成队列，之前的临时编辑不会保留。</div>

        <div className={styles.queueStatsBar}>
          <div className={styles.queueStat} data-testid='queue-total-card'>
            队列总数{' '}
            <span className={styles.queueStatValue} data-testid='queue-total-value'>
              {stats.total}
            </span>
          </div>
          <div className={styles.queueStat}>
            已编辑 <span className={styles.queueStatValue}>{stats.editedCount}</span>
          </div>
          <div className={styles.queueStat}>
            自定义 <span className={styles.queueStatValue}>{stats.customCount}</span>
          </div>
          {selectedQueueIds.length ? <div className={styles.queueStat}>已选 {selectedQueueIds.length} 项</div> : null}
        </div>

        {queue.length ? (
          <div className={styles.queueList}>
            {queue.map((item, index) => (
              <div key={item.id} className={styles.queueCard}>
                <div className={styles.queueHeader}>
                  <div className={styles.queueHeaderLeft}>
                    <Checkbox checked={selectedQueueIds.includes(item.id)} disabled={disabled} onChange={() => onToggleSelection(item.id)} />
                    <span className={styles.queueIndex}>第 {index + 1} 条</span>
                    <div className={styles.queueMeta}>
                      {item.isCustom ? <Tag color='green'>自定义</Tag> : <Tag color='blue'>提取项</Tag>}
                      {item.edited ? <Tag color='orange'>已编辑</Tag> : <Tag>原始</Tag>}
                      {item.sourceIndex !== null ? <Tag color='gray'>source #{item.sourceIndex + 1}</Tag> : null}
                      {item.tokenCount !== null ? <Tag color='gray'>{item.tokenCount} tokens</Tag> : null}
                    </div>
                  </div>
                  <Button size='small' status='danger' disabled={disabled} onClick={() => onDeleteSingle(item.id)}>
                    删除
                  </Button>
                </div>

                <div className={styles.queueRow}>
                  <Input value={item.role} disabled={disabled} placeholder='role' onChange={(value) => onQueueChange(item.id, { role: value })} />
                  <Input.TextArea value={item.text} disabled={disabled} placeholder='输入要发送给 agy 的文本' autoSize={{ minRows: 3, maxRows: 12 }} onChange={(value) => onQueueChange(item.id, { text: value })} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.emptyBox}>
            <Empty description={hasParseResult ? '当前过滤条件下没有可进入队列的内容，你可以调整 role 或关闭 thought 过滤后再试。' : '先导入一个 JSON 对话文件，这里才会生成待发送队列。'} />
          </div>
        )}
      </div>
    </section>
  );
};

export default QueueEditorPanel;
