export interface FileSnapshotEntry {
  path: string;
  size: number;
  lastModified: number;
}

export type FileSnapshot = Record<string, FileSnapshotEntry>;

export interface FileChangeSummary {
  created: string[];
  updated: string[];
  deleted: string[];
}

export const normalizeWatchExtensions = (input: string): string[] => {
  return Array.from(
    new Set(
      input
        .split(',')
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((item) => (item.startsWith('.') ? item : `.${item}`))
    )
  );
};

export const shouldIncludeFileByExtension = (filePath: string, extensions: string[]): boolean => {
  if (!extensions.length) return true;
  const normalizedPath = filePath.toLowerCase();
  return extensions.some((extension) => normalizedPath.endsWith(extension));
};

export const diffFileSnapshots = (before: FileSnapshot, after: FileSnapshot): FileChangeSummary => {
  const created: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];

  for (const [filePath, afterEntry] of Object.entries(after)) {
    const beforeEntry = before[filePath];
    if (!beforeEntry) {
      created.push(filePath);
      continue;
    }

    if (beforeEntry.size !== afterEntry.size || beforeEntry.lastModified !== afterEntry.lastModified) {
      updated.push(filePath);
    }
  }

  for (const filePath of Object.keys(before)) {
    if (!after[filePath]) {
      deleted.push(filePath);
    }
  }

  return {
    created,
    updated,
    deleted,
  };
};

export const hasFileChanges = (summary: FileChangeSummary): boolean => {
  return summary.created.length > 0 || summary.updated.length > 0 || summary.deleted.length > 0;
};
