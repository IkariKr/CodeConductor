import React from 'react';
import styles from '../index.module.css';

interface ParseSummaryPanelProps {
  totalChunks: number;
  filteredOutThoughts: number;
  skippedInvalidChunks: number;
  validChunkCount: number;
}

const ParseSummaryPanel: React.FC<ParseSummaryPanelProps> = ({ totalChunks, filteredOutThoughts, skippedInvalidChunks, validChunkCount }) => {
  return (
    <section className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>解析摘要</div>
        <div className={styles.panelDesc}>文件提取阶段的核心统计，方便确认过滤是否符合预期。</div>
      </div>

      <div className={styles.panelBody}>
        <div className={styles.statGrid}>
          <div className={styles.statCell}>
            <div className={styles.statValue}>{totalChunks}</div>
            <div className={styles.statLabel}>总 chunk 数</div>
          </div>
          <div className={styles.statCell}>
            <div className={styles.statValue}>{filteredOutThoughts}</div>
            <div className={styles.statLabel}>过滤的 thought</div>
          </div>
          <div className={styles.statCell}>
            <div className={styles.statValue}>{skippedInvalidChunks}</div>
            <div className={styles.statLabel}>异常跳过</div>
          </div>
          <div className={styles.statCell}>
            <div className={styles.statValue}>{validChunkCount}</div>
            <div className={styles.statLabel}>有效 chunk</div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default ParseSummaryPanel;
