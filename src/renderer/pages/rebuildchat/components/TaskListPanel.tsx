import { canResumeRebuildChatTask, type RebuildChatPersistedTaskSummary } from '@/common/rebuildchat/persistedTask';
import { Button, Empty, Tag } from '@arco-design/web-react';
import React from 'react';
import styles from '../index.module.css';
import { formatRetryClock, formatRetryDelay, getRetryPhaseLabel, getTaskProgressLabel, getTaskStatusLabel, getTaskTitle } from '../viewLabels';

interface TaskListPanelProps {
  taskNotice: string;
  persistedTasks: RebuildChatPersistedTaskSummary[];
  onResumeTask: (task: RebuildChatPersistedTaskSummary) => void;
  onLoadTask: (task: RebuildChatPersistedTaskSummary) => void;
  onDeleteTask: (taskId: string) => void;
}

const TaskListPanel: React.FC<TaskListPanelProps> = ({ taskNotice, persistedTasks, onResumeTask, onLoadTask, onDeleteTask }) => {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>任务列表</div>
        <div className={styles.panelDesc}>本机已保存的任务。关闭程序后可在这里载入查看，或从上次进度继续跑。</div>
      </div>

      <div className={styles.panelBody}>
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
                    <span>下次重试：{getRetryPhaseLabel(task.progress.retryState.phase)}，</span>
                    <span>{formatRetryClock(task.progress.retryState.retryAt)}，约 </span>
                    <span>{formatRetryDelay(task.progress.retryState.retryDelayMs)} 后，</span>
                    <span>已等待 {task.progress.retryState.retryAttemptCount} 次。</span>
                  </div>
                ) : null}

                <div className={styles.taskActions}>
                  {canResumeRebuildChatTask(task) ? (
                    <Button data-testid='task-resume-button' size='small' type='primary' onClick={() => onResumeTask(task)}>
                      恢复并继续
                    </Button>
                  ) : null}
                  <Button data-testid='task-load-button' size='small' onClick={() => onLoadTask(task)}>
                    载入查看
                  </Button>
                  <Button data-testid='task-delete-button' size='small' status='danger' onClick={() => onDeleteTask(task.taskId)}>
                    删除记录
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.emptyBox}>
            <Empty description='还没有保存过 RebuildChat 任务。导入文件并开始编辑后，这里会自动出现任务记录。' />
          </div>
        )}
      </div>
    </section>
  );
};

export default TaskListPanel;
