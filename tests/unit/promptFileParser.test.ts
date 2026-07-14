import { describe, expect, test } from '@jest/globals';
import { parsePromptFile, parsePromptFileObject } from '@/common/rebuildchat/promptFileParser';

describe('promptFileParser', () => {
  const sample = {
    chunkedPrompt: {
      chunks: [{ text: 'system text', role: 'system', tokenCount: 10 }, { text: 'user text', role: 'user', tokenCount: 20 }, { text: 'thought text', role: 'model', tokenCount: 30, isThought: true }, { text: 'assistant text', role: 'model', tokenCount: 40 }, { text: '   ', role: 'user', tokenCount: 50 }, { text: 'missing role' }],
    },
  };

  test('parses valid file and filters thought by default', () => {
    const result = parsePromptFileObject(sample);

    expect(result.totalChunks).toBe(6);
    expect(result.filteredOutThoughts).toBe(1);
    expect(result.skippedInvalidChunks).toBe(2);
    expect(result.availableRoles).toEqual(['system', 'user', 'model']);
    expect(result.chunks).toEqual([
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
      {
        id: 'chunk-3',
        role: 'model',
        text: 'assistant text',
        tokenCount: 40,
        isThought: false,
        sourceIndex: 3,
      },
    ]);
  });

  test('supports multi-role filtering', () => {
    const result = parsePromptFileObject(sample, {
      roles: ['user', 'model'],
    });

    expect(result.filteredOutRoles).toBe(1);
    expect(result.chunks.map((chunk) => chunk.role)).toEqual(['user', 'model']);
  });

  test('can keep thought chunks when requested', () => {
    const result = parsePromptFileObject(sample, {
      excludeThought: false,
      roles: ['model'],
    });

    expect(result.filteredOutThoughts).toBe(0);
    expect(result.chunks.map((chunk) => chunk.text)).toEqual(['thought text', 'assistant text']);
  });

  test('throws on invalid json', () => {
    expect(() => parsePromptFile('{invalid json')).toThrow(/Invalid prompt file JSON/);
  });

  test('throws when chunks array is missing', () => {
    expect(() => parsePromptFileObject({})).toThrow(/chunkedPrompt\.chunks/);
  });
});
