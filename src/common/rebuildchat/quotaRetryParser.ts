const DEFAULT_QUOTA_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_QUOTA_RETRY_BUFFER_MS = 10 * 1000;

const QUOTA_PATTERNS = [/individual\s+quota\s+reached/i, /\bquota\s+reached\b/i, /increase\s+your\s+limits/i, /rate\s+limit(?:\s+(?:reached|exceeded))?\b/i, /too\s+many\s+requests/i];

const RESET_PATTERN = /resets?\s+in\s+((?:\d+\s*[hms]\s*)+)/i;
const DURATION_PART_PATTERN = /(\d+)\s*([hms])/gi;

export type QuotaRetryDirectiveSource = 'output' | 'rawLog';

export interface QuotaRetryDirective {
  reason: 'quota';
  retryAt: number | null;
  retryDelayMs: number;
  matchedText: string;
  source: QuotaRetryDirectiveSource;
}

export interface QuotaRetryParseResult {
  matched: boolean;
  directive: QuotaRetryDirective | null;
}

export interface ParseQuotaRetryOptions {
  fallbackDelayMs?: number;
  now?: number;
  output?: string;
  rawLog?: string;
  safetyBufferMs?: number;
}

const extractMatchedText = (text: string): string => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const matchedLine = lines.find((line) => QUOTA_PATTERNS.some((pattern) => pattern.test(line)) || RESET_PATTERN.test(line));

  if (matchedLine) {
    return matchedLine.slice(0, 240);
  }

  return text.trim().slice(0, 240);
};

export const parseResetDurationMs = (text: string): number | null => {
  const matched = text.match(RESET_PATTERN);
  if (!matched?.[1]) {
    return null;
  }

  let durationMs = 0;
  let hasPart = false;
  let partMatch: RegExpExecArray | null;

  while ((partMatch = DURATION_PART_PATTERN.exec(matched[1])) !== null) {
    hasPart = true;
    const value = Number(partMatch[1]);
    const unit = partMatch[2].toLowerCase();

    if (unit === 'h') durationMs += value * 60 * 60 * 1000;
    if (unit === 'm') durationMs += value * 60 * 1000;
    if (unit === 's') durationMs += value * 1000;
  }

  DURATION_PART_PATTERN.lastIndex = 0;
  return hasPart ? durationMs : null;
};

const buildQuotaRetryDirective = (text: string, source: QuotaRetryDirectiveSource, options: ParseQuotaRetryOptions): QuotaRetryDirective => {
  const now = options.now ?? Date.now();
  const fallbackDelayMs = options.fallbackDelayMs ?? DEFAULT_QUOTA_RETRY_DELAY_MS;
  const safetyBufferMs = options.safetyBufferMs ?? DEFAULT_QUOTA_RETRY_BUFFER_MS;
  const resetDurationMs = parseResetDurationMs(text);
  const retryDelayMs = resetDurationMs === null ? fallbackDelayMs : resetDurationMs + safetyBufferMs;

  return {
    reason: 'quota',
    retryAt: now + retryDelayMs,
    retryDelayMs,
    matchedText: extractMatchedText(text),
    source,
  };
};

export const parseQuotaRetry = (options: ParseQuotaRetryOptions): QuotaRetryParseResult => {
  const sources: Array<{ text: string; source: QuotaRetryDirectiveSource }> = [
    { text: options.output ?? '', source: 'output' },
    { text: options.rawLog ?? '', source: 'rawLog' },
  ];

  for (const candidate of sources) {
    const normalized = candidate.text.trim();
    if (!normalized) {
      continue;
    }

    if (QUOTA_PATTERNS.some((pattern) => pattern.test(normalized))) {
      return {
        matched: true,
        directive: buildQuotaRetryDirective(normalized, candidate.source, options),
      };
    }
  }

  return {
    matched: false,
    directive: null,
  };
};
