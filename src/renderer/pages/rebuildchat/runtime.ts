import { ipcBridge } from '@/common';
import { buildAgyTurnArgs } from '@/common/rebuildchat/agyCommand';
import type { IDirOrFile } from '@/common/ipcBridge';
import { parseAgyConversationId } from '@/common/rebuildchat/agyLogParser';
import { diffFileSnapshots, normalizeWatchExtensions, shouldIncludeFileByExtension, type FileChangeSummary, type FileSnapshot } from '@/common/rebuildchat/fileChangeTracker';
import { parseError } from '@/common/utils';

const AGY_COMMAND = 'agy';
const DEFAULT_DIR_SNAPSHOT_DEPTH = 8;
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export interface AgyTurnOptions {
  prompt: string;
  cwd: string;
  conversationId?: string | null;
  skipPermissions?: boolean;
}

export interface AgyTurnResult {
  output: string;
  conversationId: string | null;
  exitCode: number | null;
  logFilePath: string;
  rawLog: string;
}

export interface AgyTurnExecution {
  id: string;
  promise: Promise<AgyTurnResult>;
  abort: () => Promise<void>;
}

export interface RebuildChatRuntimeDriver {
  compareDirectorySnapshots: (before: FileSnapshot, after: FileSnapshot) => FileChangeSummary;
  formatRuntimeError: (error: unknown) => string;
  getParentDirectory: (filePath: string) => string;
  snapshotDirectory: (directory: string, extensionsInput: string) => Promise<FileSnapshot>;
  startAgyPrintTurn: (options: AgyTurnOptions) => Promise<AgyTurnExecution>;
}

declare global {
  interface Window {
    __REBUILDCHAT_RUNTIME_OVERRIDE__?: Partial<RebuildChatRuntimeDriver>;
  }
}

const flattenFiles = (nodes: IDirOrFile[]): string[] => {
  const result: string[] = [];

  const walk = (items: IDirOrFile[]) => {
    items.forEach((item) => {
      if (item.isFile) {
        result.push(item.fullPath);
      }

      if (item.children?.length) {
        walk(item.children);
      }
    });
  };

  walk(nodes);
  return result;
};

const stripAnsi = (value: string): string => value.replace(ANSI_PATTERN, '');

export const snapshotDirectory = async (directory: string, extensionsInput: string): Promise<FileSnapshot> => {
  if (!directory) return {};

  const extensions = normalizeWatchExtensions(extensionsInput);
  const tree = await ipcBridge.fs.getFilesByDir.invoke({
    dir: directory,
    root: directory,
    maxDepth: DEFAULT_DIR_SNAPSHOT_DEPTH,
  });

  const filePaths = flattenFiles(tree).filter((filePath) => shouldIncludeFileByExtension(filePath, extensions));
  const metadataList = await Promise.all(
    filePaths.map(async (filePath) => {
      const metadata = await ipcBridge.fs.getFileMetadata.invoke({ path: filePath });
      return {
        path: filePath,
        size: metadata.size,
        lastModified: metadata.lastModified,
      };
    })
  );

  return metadataList.reduce<FileSnapshot>((accumulator, item) => {
    accumulator[item.path] = item;
    return accumulator;
  }, {});
};

export const compareDirectorySnapshots = (before: FileSnapshot, after: FileSnapshot): FileChangeSummary => {
  return diffFileSnapshots(before, after);
};

export const startAgyPrintTurn = async (options: AgyTurnOptions): Promise<AgyTurnExecution> => {
  const logFilePath = await ipcBridge.fs.createTempFile.invoke({
    fileName: `rebuildchat-agy-${Date.now()}.log`,
  });

  const args = buildAgyTurnArgs({
    prompt: options.prompt,
    logFilePath,
    conversationId: options.conversationId,
    skipPermissions: options.skipPermissions,
  });

  const spawnResult = await ipcBridge.terminal.spawn.invoke({
    cwd: options.cwd,
    shell: AGY_COMMAND,
    args,
  });

  if (!spawnResult?.success || !spawnResult.data?.id) {
    throw new Error(spawnResult?.msg || 'Failed to start agy process.');
  }

  const terminalId = spawnResult.data.id;

  const promise = new Promise<AgyTurnResult>((resolve) => {
    let output = '';

    const unsubscribeData = ipcBridge.terminal.data.on((payload) => {
      if (payload.id !== terminalId) return;
      output += payload.data;
    });

    const unsubscribeExit = ipcBridge.terminal.exit.on((payload) => {
      if (payload.id !== terminalId) return;

      unsubscribeData?.();
      unsubscribeExit?.();

      void ipcBridge.fs.readFile
        .invoke({ path: logFilePath })
        .catch(() => '')
        .then((rawLog) => {
          resolve({
            output: stripAnsi(output).trim(),
            conversationId: parseAgyConversationId(rawLog),
            exitCode: payload.exitCode,
            logFilePath,
            rawLog,
          });
        });
    });
  });

  return {
    id: terminalId,
    promise,
    abort: () => ipcBridge.terminal.dispose.invoke({ id: terminalId }).then(() => {}),
  };
};

export const getParentDirectory = (filePath: string): string => {
  if (!filePath) return '';
  const normalized = filePath.replace(/[\\/]+$/, '');
  const lastSlashIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  if (lastSlashIndex <= 0) return normalized;
  return normalized.slice(0, lastSlashIndex);
};

export const formatRuntimeError = (error: unknown): string => {
  return parseError(error);
};

const defaultRuntimeDriver: RebuildChatRuntimeDriver = {
  compareDirectorySnapshots,
  formatRuntimeError,
  getParentDirectory,
  snapshotDirectory,
  startAgyPrintTurn,
};

export const getRebuildChatRuntimeDriver = (): RebuildChatRuntimeDriver => {
  if (typeof window === 'undefined') {
    return defaultRuntimeDriver;
  }

  return {
    ...defaultRuntimeDriver,
    ...(window.__REBUILDCHAT_RUNTIME_OVERRIDE__ || {}),
  };
};
