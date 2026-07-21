import type { ParsePromptFileResult } from '@/common/rebuildchat/promptFileParser';
import { Button, Switch, Tag } from '@arco-design/web-react';
import { Refresh, UploadOne } from '@icon-park/react';
import React from 'react';
import styles from '../index.module.css';

interface InputPanelProps {
  filePath: string;
  loading: boolean;
  disabled: boolean;
  errorText: string;
  excludeThought: boolean;
  onExcludeThoughtChange: (checked: boolean) => void;
  parseResult: ParsePromptFileResult | null;
  selectedRoles: string[];
  onToggleRole: (role: string) => void;
  onPickFile: () => void;
  onReload: () => void;
}

const InputPanel: React.FC<InputPanelProps> = ({ filePath, loading, disabled, errorText, excludeThought, onExcludeThoughtChange, parseResult, selectedRoles, onToggleRole, onPickFile, onReload }) => {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>输入区</div>
        <div className={styles.panelDesc}>先选文件，再确认过滤条件。切换过滤条件会重建待发送队列。</div>
      </div>

      <div className={styles.panelBody}>
        <div className={styles.buttonRow}>
          <Button data-testid='pick-json-file' type='primary' icon={<UploadOne theme='outline' size='16' fill='currentColor' />} loading={loading} disabled={disabled} onClick={onPickFile}>
            选择 JSON 文件
          </Button>
          <Button data-testid='reload-json-file' icon={<Refresh theme='outline' size='16' fill='currentColor' />} disabled={!filePath || loading || disabled} onClick={onReload}>
            重新读取
          </Button>
        </div>

        <div className={styles.pathBox}>{filePath || '还没有选择文件。'}</div>

        <div className={styles.fieldRow}>
          <div className={styles.fieldLabel}>默认过滤 thought</div>
          <Switch checked={excludeThought} disabled={disabled} onChange={onExcludeThoughtChange} />
        </div>

        <div>
          <div className={styles.fieldLabel}>role 多选</div>
          <div className={styles.roleWrap}>
            {(parseResult?.availableRoles || []).map((role) => {
              const checked = selectedRoles.includes(role);
              return (
                <Tag key={role} checkable checked={checked} onCheck={() => !disabled && onToggleRole(role)} color={checked ? 'blue' : undefined}>
                  {role}
                </Tag>
              );
            })}
          </div>
          <div className={styles.fieldHint}>{parseResult ? `可选角色 ${parseResult.availableRoles.length} 个，当前选中 ${selectedRoles.length} 个。` : '选择文件后会在这里展示可用 role。'}</div>
        </div>

        {errorText ? <div className={styles.notice}>{errorText}</div> : null}
      </div>
    </section>
  );
};

export default InputPanel;
