import { describe, expect, test } from '@jest/globals';
import { buildAgyTurnArgs } from '@/common/rebuildchat/agyCommand';

describe('agyCommand', () => {
  test('builds first-turn args with new-project', () => {
    expect(
      buildAgyTurnArgs({
        prompt: 'hello',
        logFilePath: 'C:\\temp\\agy.log',
        skipPermissions: true,
      })
    ).toEqual(['--mode', 'accept-edits', '--log-file', 'C:\\temp\\agy.log', '--dangerously-skip-permissions', '--new-project', '--print', 'hello']);
  });

  test('builds resumed-turn args with conversation id', () => {
    expect(
      buildAgyTurnArgs({
        prompt: 'hello again',
        logFilePath: 'C:\\temp\\agy.log',
        conversationId: 'abc-123',
      })
    ).toEqual(['--mode', 'accept-edits', '--log-file', 'C:\\temp\\agy.log', '--conversation', 'abc-123', '--print', 'hello again']);
  });
});
