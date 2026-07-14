import { describe, expect, test } from '@jest/globals';
import { appendCustomPromptQueueItem, createEditablePromptQueue, removeEditablePromptQueueItems, updateEditablePromptQueueItem } from '@/common/rebuildchat/editablePromptQueue';
import type { PromptChunk } from '@/common/rebuildchat/promptFileParser';

describe('editablePromptQueue', () => {
  const chunks: PromptChunk[] = [
    {
      id: 'chunk-0',
      role: 'system',
      text: 'system text',
      tokenCount: 10,
      isThought: false,
      sourceIndex: 0,
    },
    {
      id: 'chunk-1',
      role: 'user',
      text: 'user text',
      tokenCount: 20,
      isThought: false,
      sourceIndex: 1,
    },
  ];

  test('creates editable queue items from parsed chunks', () => {
    expect(createEditablePromptQueue(chunks)).toEqual([
      {
        id: 'queue-chunk-0',
        sourceChunkId: 'chunk-0',
        role: 'system',
        text: 'system text',
        tokenCount: 10,
        sourceIndex: 0,
        isThought: false,
        isCustom: false,
        edited: false,
      },
      {
        id: 'queue-chunk-1',
        sourceChunkId: 'chunk-1',
        role: 'user',
        text: 'user text',
        tokenCount: 20,
        sourceIndex: 1,
        isThought: false,
        isCustom: false,
        edited: false,
      },
    ]);
  });

  test('updates a single queue item and marks it as edited', () => {
    const queue = createEditablePromptQueue(chunks);

    expect(updateEditablePromptQueueItem(queue, 'queue-chunk-1', { text: 'updated text', role: 'assistant' })).toEqual([
      queue[0],
      {
        ...queue[1],
        role: 'assistant',
        text: 'updated text',
        edited: true,
      },
    ]);
  });

  test('appends custom queue item to the end', () => {
    const queue = createEditablePromptQueue(chunks);
    const nextQueue = appendCustomPromptQueueItem(queue, { role: 'user', text: 'custom text' });
    const appended = nextQueue[nextQueue.length - 1];

    expect(nextQueue).toHaveLength(3);
    expect(appended).toMatchObject({
      sourceChunkId: null,
      role: 'user',
      text: 'custom text',
      tokenCount: null,
      sourceIndex: null,
      isThought: false,
      isCustom: true,
      edited: true,
    });
    expect(appended.id.startsWith('custom-')).toBe(true);
  });

  test('removes multiple selected queue items', () => {
    const queue = appendCustomPromptQueueItem(createEditablePromptQueue(chunks), { role: 'model', text: 'custom text' });
    const idsToDelete = [queue[0].id, queue[2].id];

    expect(removeEditablePromptQueueItems(queue, idsToDelete)).toEqual([queue[1]]);
  });
});
