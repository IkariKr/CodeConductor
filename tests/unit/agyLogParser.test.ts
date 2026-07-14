import { describe, expect, test } from '@jest/globals';
import { parseAgyConversationId } from '@/common/rebuildchat/agyLogParser';

describe('agyLogParser', () => {
  test('extracts newly created conversation id from agy log', () => {
    const log = `
I0714 01:25:07.072209 56800 server.go:861] Created conversation cd8df5e8-9bf8-4d16-bd25-dc199521dbc8
I0714 01:25:07.073800 56800 printmode.go:191] Print mode: conversation=cd8df5e8-9bf8-4d16-bd25-dc199521dbc8, sending message
`;

    expect(parseAgyConversationId(log)).toBe('cd8df5e8-9bf8-4d16-bd25-dc199521dbc8');
  });

  test('extracts resumed conversation id from agy log', () => {
    const log = `
I0714 01:25:42.918582 5984 printmode.go:181] Print mode: resuming conversation cd8df5e8-9bf8-4d16-bd25-dc199521dbc8
I0714 01:25:42.918582 5984 printmode.go:191] Print mode: conversation=cd8df5e8-9bf8-4d16-bd25-dc199521dbc8, sending message
`;

    expect(parseAgyConversationId(log)).toBe('cd8df5e8-9bf8-4d16-bd25-dc199521dbc8');
  });

  test('returns null when conversation id cannot be found', () => {
    expect(parseAgyConversationId('no conversation id here')).toBeNull();
  });
});
