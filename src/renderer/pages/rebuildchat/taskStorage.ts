import { ConfigStorage } from '@/common/storage';
import { normalizeRebuildChatTasks, sortRebuildChatTasks, type RebuildChatPersistedTask } from '@/common/rebuildchat/persistedTask';

export const loadRebuildChatTasks = async (): Promise<RebuildChatPersistedTask[]> => {
  const stored = await ConfigStorage.get('rebuildchat.tasks').catch((): unknown => []);
  return normalizeRebuildChatTasks(stored);
};

export const saveRebuildChatTasks = async (tasks: RebuildChatPersistedTask[]): Promise<void> => {
  await ConfigStorage.set('rebuildchat.tasks', sortRebuildChatTasks(tasks));
};
