import { describe, expect, test } from '@jest/globals';
import { diffFileSnapshots, hasFileChanges, normalizeWatchExtensions, shouldIncludeFileByExtension, type FileSnapshot } from '@/common/rebuildchat/fileChangeTracker';

describe('fileChangeTracker', () => {
  test('normalizes watch extensions from comma-separated input', () => {
    expect(normalizeWatchExtensions('md, .ts,md, JSON ')).toEqual(['.md', '.ts', '.json']);
  });

  test('matches files by normalized extensions', () => {
    expect(shouldIncludeFileByExtension('D:\\demo\\note.md', ['.md'])).toBe(true);
    expect(shouldIncludeFileByExtension('D:\\demo\\note.txt', ['.md'])).toBe(false);
    expect(shouldIncludeFileByExtension('D:\\demo\\note.txt', [])).toBe(true);
  });

  test('detects created, updated, and deleted files', () => {
    const before: FileSnapshot = {
      'D:\\demo\\a.md': { path: 'D:\\demo\\a.md', size: 10, lastModified: 100 },
      'D:\\demo\\b.md': { path: 'D:\\demo\\b.md', size: 20, lastModified: 200 },
    };
    const after: FileSnapshot = {
      'D:\\demo\\a.md': { path: 'D:\\demo\\a.md', size: 11, lastModified: 101 },
      'D:\\demo\\c.md': { path: 'D:\\demo\\c.md', size: 30, lastModified: 300 },
    };

    expect(diffFileSnapshots(before, after)).toEqual({
      created: ['D:\\demo\\c.md'],
      updated: ['D:\\demo\\a.md'],
      deleted: ['D:\\demo\\b.md'],
    });
  });

  test('reports whether snapshot diff has changes', () => {
    expect(hasFileChanges({ created: [], updated: [], deleted: [] })).toBe(false);
    expect(hasFileChanges({ created: ['a'], updated: [], deleted: [] })).toBe(true);
  });
});
