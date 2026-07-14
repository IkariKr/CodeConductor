export interface PromptChunk {
  id: string;
  role: string;
  text: string;
  tokenCount: number | null;
  isThought: boolean;
  sourceIndex: number;
}

export interface ParsePromptFileOptions {
  roles?: string[];
  excludeThought?: boolean;
  trimEmptyText?: boolean;
}

export interface ParsePromptFileResult {
  chunks: PromptChunk[];
  availableRoles: string[];
  totalChunks: number;
  filteredOutThoughts: number;
  filteredOutRoles: number;
  skippedInvalidChunks: number;
}

interface PromptFileChunkShape {
  text?: unknown;
  role?: unknown;
  tokenCount?: unknown;
  isThought?: unknown;
}

interface PromptFileShape {
  chunkedPrompt?: {
    chunks?: PromptFileChunkShape[];
  };
}

const DEFAULT_OPTIONS: Required<Pick<ParsePromptFileOptions, 'excludeThought' | 'trimEmptyText'>> = {
  excludeThought: true,
  trimEmptyText: true,
};

const normalizeRoles = (roles?: string[]): Set<string> | null => {
  if (!roles?.length) return null;
  const normalized = roles.map((role) => role.trim()).filter(Boolean);
  return normalized.length ? new Set(normalized) : null;
};

const normalizeText = (value: unknown, trimEmptyText: boolean): string | null => {
  if (typeof value !== 'string') return null;
  const normalized = trimEmptyText ? value.trim() : value;
  return normalized ? normalized : null;
};

const toTokenCount = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

export function parsePromptFileObject(data: PromptFileShape, options: ParsePromptFileOptions = {}): ParsePromptFileResult {
  const chunks = data?.chunkedPrompt?.chunks;
  if (!Array.isArray(chunks)) {
    throw new Error('Invalid prompt file: chunkedPrompt.chunks is missing or not an array.');
  }

  const excludeThought = options.excludeThought ?? DEFAULT_OPTIONS.excludeThought;
  const trimEmptyText = options.trimEmptyText ?? DEFAULT_OPTIONS.trimEmptyText;
  const roleFilter = normalizeRoles(options.roles);
  const availableRoles = new Set<string>();

  const result: ParsePromptFileResult = {
    chunks: [],
    availableRoles: [],
    totalChunks: chunks.length,
    filteredOutThoughts: 0,
    filteredOutRoles: 0,
    skippedInvalidChunks: 0,
  };

  chunks.forEach((chunk, index) => {
    const role = typeof chunk?.role === 'string' ? chunk.role.trim() : '';
    const text = normalizeText(chunk?.text, trimEmptyText);

    if (role) {
      availableRoles.add(role);
    }

    if (!role || text === null) {
      result.skippedInvalidChunks += 1;
      return;
    }

    const isThought = chunk?.isThought === true;
    if (excludeThought && isThought) {
      result.filteredOutThoughts += 1;
      return;
    }

    if (roleFilter && !roleFilter.has(role)) {
      result.filteredOutRoles += 1;
      return;
    }

    result.chunks.push({
      id: `chunk-${index}`,
      role,
      text,
      tokenCount: toTokenCount(chunk?.tokenCount),
      isThought,
      sourceIndex: index,
    });
  });

  result.availableRoles = Array.from(availableRoles);
  return result;
}

export function parsePromptFile(raw: string, options: ParsePromptFileOptions = {}): ParsePromptFileResult {
  let parsed: PromptFileShape;
  try {
    parsed = JSON.parse(raw) as PromptFileShape;
  } catch (error) {
    throw new Error(`Invalid prompt file JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  return parsePromptFileObject(parsed, options);
}
