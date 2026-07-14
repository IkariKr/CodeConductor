import type { PromptChunk } from './promptFileParser';
import { uuid } from '@/common/utils';

export interface EditablePromptQueueItem {
  id: string;
  sourceChunkId: string | null;
  role: string;
  text: string;
  tokenCount: number | null;
  sourceIndex: number | null;
  isThought: boolean;
  isCustom: boolean;
  edited: boolean;
}

export interface CreateCustomPromptQueueItemOptions {
  role?: string;
  text?: string;
}

export interface UpdateEditablePromptQueueItem {
  role?: string;
  text?: string;
}

export const createEditablePromptQueue = (chunks: PromptChunk[]): EditablePromptQueueItem[] => {
  return chunks.map((chunk) => ({
    id: `queue-${chunk.id}`,
    sourceChunkId: chunk.id,
    role: chunk.role,
    text: chunk.text,
    tokenCount: chunk.tokenCount,
    sourceIndex: chunk.sourceIndex,
    isThought: chunk.isThought,
    isCustom: false,
    edited: false,
  }));
};

export const createCustomPromptQueueItem = (options: CreateCustomPromptQueueItemOptions = {}): EditablePromptQueueItem => {
  return {
    id: `custom-${uuid(12)}`,
    sourceChunkId: null,
    role: options.role?.trim() || 'user',
    text: options.text ?? '',
    tokenCount: null,
    sourceIndex: null,
    isThought: false,
    isCustom: true,
    edited: true,
  };
};

export const appendCustomPromptQueueItem = (queue: EditablePromptQueueItem[], options: CreateCustomPromptQueueItemOptions = {}): EditablePromptQueueItem[] => {
  return [...queue, createCustomPromptQueueItem(options)];
};

export const updateEditablePromptQueueItem = (queue: EditablePromptQueueItem[], id: string, updates: UpdateEditablePromptQueueItem): EditablePromptQueueItem[] => {
  return queue.map((item) => {
    if (item.id !== id) return item;

    return {
      ...item,
      role: updates.role ?? item.role,
      text: updates.text ?? item.text,
      edited: true,
    };
  });
};

export const removeEditablePromptQueueItems = (queue: EditablePromptQueueItem[], ids: string[]): EditablePromptQueueItem[] => {
  if (!ids.length) return queue;
  const toDelete = new Set(ids);
  return queue.filter((item) => !toDelete.has(item.id));
};
