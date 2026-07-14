export interface BuildAgyTurnArgsOptions {
  prompt: string;
  logFilePath: string;
  conversationId?: string | null;
  skipPermissions?: boolean;
}

export const buildAgyTurnArgs = (options: BuildAgyTurnArgsOptions): string[] => {
  const args = ['--mode', 'accept-edits', '--log-file', options.logFilePath];

  if (options.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }

  if (options.conversationId) {
    args.push('--conversation', options.conversationId);
  } else {
    args.push('--new-project');
  }

  args.push('--print', options.prompt);
  return args;
};
