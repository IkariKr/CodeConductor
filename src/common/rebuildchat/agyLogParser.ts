const CREATED_CONVERSATION_PATTERN = /Created conversation ([0-9a-f-]{36})/i;
const RESUME_CONVERSATION_PATTERN = /Print mode: conversation=([0-9a-f-]{36})/i;
const RESUMING_CONVERSATION_PATTERN = /Print mode: resuming conversation ([0-9a-f-]{36})/i;

export const parseAgyConversationId = (logText: string): string | null => {
  if (!logText) return null;

  const patterns = [RESUME_CONVERSATION_PATTERN, RESUMING_CONVERSATION_PATTERN, CREATED_CONVERSATION_PATTERN];
  for (const pattern of patterns) {
    const match = logText.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return null;
};
