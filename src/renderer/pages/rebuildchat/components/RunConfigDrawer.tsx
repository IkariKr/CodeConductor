import { Button, Drawer, Input, Switch } from '@arco-design/web-react';
import React from 'react';
import styles from '../index.module.css';

interface RunConfigDrawerProps {
  visible: boolean;
  onClose: () => void;
  disabled: boolean;
  workDir: string;
  onWorkDirChange: (value: string) => void;
  watchDir: string;
  onWatchDirChange: (value: string) => void;
  onPickDirectory: (onSelect: (value: string) => void) => void;
  watchExtensionsInput: string;
  onWatchExtensionsInputChange: (value: string) => void;
  maxRoundsInput: string;
  onMaxRoundsInputChange: (value: string) => void;
  executionTimeoutMinutesInput: string;
  onExecutionTimeoutMinutesInputChange: (value: string) => void;
  executionErrorRetryCountInput: string;
  onExecutionErrorRetryCountInputChange: (value: string) => void;
  conversationResetEveryNRoundsInput: string;
  onConversationResetEveryNRoundsInputChange: (value: string) => void;
  startTurnInput: string;
  onStartTurnInputChange: (value: string) => void;
  startPromptInput: string;
  onStartPromptInputChange: (value: string) => void;
  includeHistoryContext: boolean;
  onIncludeHistoryContextChange: (checked: boolean) => void;
  skipTurnOnNoOutput: boolean;
  onSkipTurnOnNoOutputChange: (checked: boolean) => void;
  reuseConversationOnManualStart: boolean;
  onReuseConversationOnManualStartChange: (checked: boolean) => void;
  skipPermissions: boolean;
  onSkipPermissionsChange: (checked: boolean) => void;
}

const RunConfigDrawer: React.FC<RunConfigDrawerProps> = (props) => {
  const { visible, onClose, disabled, onPickDirectory } = props;

  return (
    <Drawer visible={visible} onCancel={onClose} title='运行配置' width={520} footer={null} className={styles.configDrawer}>
      <div className={styles.configBody}>
        <div className={styles.panelDesc}>工作目录、产出监控目录、历史上下文策略、最大轮数与停止规则。</div>

        <div>
          <div className={styles.fieldLabel}>agy 工作目录</div>
          <div className={styles.inlinePicker}>
            <Input value={props.workDir} disabled={disabled} placeholder='选择 agy 运行目录' onChange={props.onWorkDirChange} />
            <Button disabled={disabled} onClick={() => void onPickDirectory(props.onWorkDirChange)}>
              选目录
            </Button>
          </div>
        </div>

        <div>
          <div className={styles.fieldLabel}>产出监控目录</div>
          <div className={styles.inlinePicker}>
            <Input value={props.watchDir} disabled={disabled} placeholder='选择要监控的目录' onChange={props.onWatchDirChange} />
            <Button disabled={disabled} onClick={() => void onPickDirectory(props.onWatchDirChange)}>
              选目录
            </Button>
          </div>
        </div>

        <div className={styles.configGrid}>
          <div>
            <div className={styles.fieldLabel}>监控后缀</div>
            <Input value={props.watchExtensionsInput} disabled={disabled} placeholder='.md,.ts,.json，留空表示全部' onChange={props.onWatchExtensionsInputChange} />
          </div>
          <div>
            <div className={styles.fieldLabel}>最大轮数</div>
            <Input value={props.maxRoundsInput} disabled={disabled} placeholder='留空表示跑完整个队列' onChange={props.onMaxRoundsInputChange} />
          </div>
          <div>
            <div className={styles.fieldLabel}>单次执行超时（分钟）</div>
            <Input data-testid='run-execution-timeout-input' value={props.executionTimeoutMinutesInput} disabled={disabled} placeholder='默认 10，超时后会自动重试一次' onChange={props.onExecutionTimeoutMinutesInputChange} />
            <div className={styles.fieldHint}>同一个正文轮次或起始 prompt 超过设定分钟数，会自动中止并立即重试 1 次。</div>
          </div>
          <div>
            <div className={styles.fieldLabel}>普通错误重试次数</div>
            <Input data-testid='run-execution-error-retry-count-input' value={props.executionErrorRetryCountInput} disabled={disabled} placeholder='默认 1，填 0 表示报错后直接暂停' onChange={props.onExecutionErrorRetryCountInputChange} />
            <div className={styles.fieldHint}>非 quota、非超时、非人工中止的普通执行错误，会在当前阶段立即重试这里设定的次数。</div>
          </div>
          <div>
            <div className={styles.fieldLabel}>每 N 轮自动断开会话</div>
            <Input data-testid='run-conversation-reset-input' value={props.conversationResetEveryNRoundsInput} disabled={disabled} placeholder='留空表示一直沿用同一个 conversationId' onChange={props.onConversationResetEveryNRoundsInputChange} />
            <div className={styles.fieldHint}>例如填 10，表示每跑满 10 轮后，下一轮会自动新开 conversationId。</div>
          </div>
          <div>
            <div className={styles.fieldLabel}>起始轮次</div>
            <Input data-testid='run-start-turn-input' value={props.startTurnInput} disabled={disabled} placeholder='例如 46，表示从编辑区第 46 条开始' onChange={props.onStartTurnInputChange} />
            <div className={styles.fieldHint}>这里对应编辑区顺序编号，1 表示第 1 条。</div>
          </div>
        </div>

        <div>
          <div className={styles.fieldLabel}>起始 prompt</div>
          <Input.TextArea data-testid='run-start-prompt-input' value={props.startPromptInput} disabled={disabled} placeholder='留空表示跳过。开始任务前，以及自动断开旧会话后，都会先把这里的内容发送给 agy。' autoSize={{ minRows: 3, maxRows: 8 }} onChange={props.onStartPromptInputChange} />
          <div className={styles.fieldHint}>这段内容不会计入正文轮次，也不会占用编辑区编号。</div>
        </div>

        <div className={styles.toggleGrid}>
          <div className={styles.toggleRow}>
            <div>
              <div className={styles.toggleTitle}>第二轮起拼接历史</div>
              <div className={styles.fieldHint}>关闭时每轮只发当前条目，开启时会把前面条目一起拼进 prompt。</div>
            </div>
            <Switch checked={props.includeHistoryContext} disabled={disabled} onChange={props.onIncludeHistoryContextChange} />
          </div>

          <div className={styles.toggleRow}>
            <div>
              <div className={styles.toggleTitle}>无产出跳过本轮</div>
              <div className={styles.fieldHint}>首次无产出会新开会话重试一次；再次无产出时，开启则跳过本轮，关闭则暂停。</div>
            </div>
            <Switch checked={props.skipTurnOnNoOutput} disabled={disabled} onChange={props.onSkipTurnOnNoOutputChange} />
          </div>

          <div className={styles.toggleRow}>
            <div>
              <div className={styles.toggleTitle}>手动改起点时沿用当前会话</div>
              <div className={styles.fieldHint}>关闭时会新开 agy 会话；开启时会沿用当前 conversationId 继续发指定轮次。</div>
            </div>
            <Switch data-testid='run-reuse-conversation-switch' checked={props.reuseConversationOnManualStart} disabled={disabled} onChange={props.onReuseConversationOnManualStartChange} />
          </div>

          <div className={styles.toggleRow}>
            <div>
              <div className={styles.toggleTitle}>自动跳过权限确认</div>
              <div className={styles.fieldHint}>会追加 `--dangerously-skip-permissions`，适合内部环境快速跑通，但风险更高。</div>
            </div>
            <Switch checked={props.skipPermissions} disabled={disabled} onChange={props.onSkipPermissionsChange} />
          </div>
        </div>
      </div>
    </Drawer>
  );
};

export default RunConfigDrawer;
