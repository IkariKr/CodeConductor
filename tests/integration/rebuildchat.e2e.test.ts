import { describe, expect, jest, test } from '@jest/globals';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { buildAgyTurnArgs } from '@/common/rebuildchat/agyCommand';
import { parseAgyConversationId } from '@/common/rebuildchat/agyLogParser';
import { createEditablePromptQueue, updateEditablePromptQueueItem } from '@/common/rebuildchat/editablePromptQueue';
import { diffFileSnapshots, hasFileChanges, type FileSnapshot } from '@/common/rebuildchat/fileChangeTracker';
import { parsePromptFileObject } from '@/common/rebuildchat/promptFileParser';

jest.setTimeout(180000);

const AGY_COMMAND = process.platform === 'win32' ? 'agy.exe' : 'agy';

interface RunAgyTurnOptions {
  cwd: string;
  prompt: string;
  conversationId?: string | null;
}

const captureSnapshot = async (directory: string): Promise<FileSnapshot> => {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const snapshot: FileSnapshot = {};

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(directory, entry.name);
    const stats = await fs.stat(fullPath);
    snapshot[fullPath] = {
      path: fullPath,
      size: stats.size,
      lastModified: stats.mtimeMs,
    };
  }

  return snapshot;
};

const runAgyTurn = async ({ cwd, prompt, conversationId }: RunAgyTurnOptions): Promise<{ output: string; exitCode: number | null; conversationId: string | null }> => {
  const logFilePath = path.join(os.tmpdir(), `rebuildchat-agy-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  const args = buildAgyTurnArgs({
    prompt,
    logFilePath,
    conversationId,
    skipPermissions: true,
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(AGY_COMMAND, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk.toString());
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });

  const rawLog = await fs.readFile(logFilePath, 'utf-8');
  return {
    output: `${stdoutChunks.join('')}${stderrChunks.join('')}`.trim(),
    exitCode,
    conversationId: parseAgyConversationId(rawLog),
  };
};

describe('rebuildchat e2e smoke', () => {
  test('runs parsed queue through agy with continued conversation and file-change detection', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rebuildchat-e2e-'));
    const targetFile = path.join(workDir, 'summary.md');

    const sample = {
      chunkedPrompt: {
        chunks: [
          {
            text: '请在当前目录创建一个名为 summary.md 的文件，内容只写第一行 FIRST LINE。完成后只回复 DONE。',
            role: 'user',
            tokenCount: 20,
          },
          {
            text: 'internal thought',
            role: 'model',
            tokenCount: 10,
            isThought: true,
          },
          {
            text: '请把 summary.md 修改成两行，第二行写 SECOND LINE。完成后只回复 DONE。',
            role: 'user',
            tokenCount: 20,
          },
          {
            text: '请只回复 NO_CHANGE，不要创建、删除、修改任何文件。',
            role: 'user',
            tokenCount: 12,
          },
        ],
      },
    };

    const parsed = parsePromptFileObject(sample, {
      roles: ['user'],
      excludeThought: true,
    });
    const initialQueue = createEditablePromptQueue(parsed.chunks);
    const queue = updateEditablePromptQueueItem(initialQueue, initialQueue[1].id, {
      text: '请把 summary.md 修改成两行，第二行写 SECOND LINE EDITED。完成后只回复 DONE。',
    });

    let conversationId: string | null = null;

    const beforeFirstTurn = await captureSnapshot(workDir);
    const firstTurn = await runAgyTurn({
      cwd: workDir,
      prompt: queue[0].text,
    });
    const afterFirstTurn = await captureSnapshot(workDir);
    const firstDiff = diffFileSnapshots(beforeFirstTurn, afterFirstTurn);

    expect(firstTurn.exitCode).toBe(0);
    expect(firstTurn.output).toContain('DONE');
    expect(firstTurn.conversationId).toMatch(/[0-9a-f-]{36}/i);
    expect(hasFileChanges(firstDiff)).toBe(true);
    expect(firstDiff.created).toContain(targetFile);

    conversationId = firstTurn.conversationId;

    const beforeSecondTurn = await captureSnapshot(workDir);
    const secondTurn = await runAgyTurn({
      cwd: workDir,
      prompt: queue[1].text,
      conversationId,
    });
    const afterSecondTurn = await captureSnapshot(workDir);
    const secondDiff = diffFileSnapshots(beforeSecondTurn, afterSecondTurn);

    expect(secondTurn.exitCode).toBe(0);
    expect(secondTurn.output).toContain('DONE');
    expect(secondTurn.conversationId).toBe(conversationId);
    expect(hasFileChanges(secondDiff)).toBe(true);
    expect(secondDiff.updated).toContain(targetFile);
    await expect(fs.readFile(targetFile, 'utf-8')).resolves.toContain('SECOND LINE EDITED');

    const beforeThirdTurn = await captureSnapshot(workDir);
    const thirdTurn = await runAgyTurn({
      cwd: workDir,
      prompt: queue[2].text,
      conversationId,
    });
    const afterThirdTurn = await captureSnapshot(workDir);
    const thirdDiff = diffFileSnapshots(beforeThirdTurn, afterThirdTurn);

    expect(thirdTurn.exitCode).toBe(0);
    expect(thirdTurn.output).toContain('NO_CHANGE');
    expect(thirdTurn.conversationId).toBe(conversationId);
    expect(hasFileChanges(thirdDiff)).toBe(false);
  });
});
