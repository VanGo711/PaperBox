export interface SelectableModel {
  id: string;
  name: string;
  capabilities?: string[];
}

export const enabledChatModelsStorageKey = 'paperbox-enabled-chat-models-v1';
export const selectedKnowledgeModelStorageKey = 'paperbox-knowledge-selected-model-v1';

export function knowledgeModelKey(platformId: string, modelId: string) {
  return `${platformId}:${modelId}`;
}

export function filterChatModels<T extends SelectableModel>(models: T[]): T[] {
  return models
    .filter((model) => !/\p{Script=Han}/u.test(model.name)
      && (Array.isArray(model.capabilities) ? model.capabilities : []).some((capability) => String(capability).trim().toUpperCase() === 'TG'))
    .map((model) => {
      const capabilities = (Array.isArray(model.capabilities) ? model.capabilities : []).map((capability) => String(capability).trim()).filter(Boolean);
      const otherCapabilities = capabilities.filter((capability) => capability.toUpperCase() !== 'TG');
      return { ...model, capabilities: ['TG', ...otherCapabilities] };
    });
}

export function readEnabledChatModelKeys(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(enabledChatModelsStorageKey) ?? '[]');
    return Array.isArray(saved) ? [...new Set(saved.filter((item): item is string => typeof item === 'string' && item.length > 0))] : [];
  } catch { return []; }
}

export function saveEnabledChatModelKeys(keys: string[]) {
  try {
    localStorage.setItem(enabledChatModelsStorageKey, JSON.stringify([...new Set(keys)]));
    return true;
  } catch { return false; }
}

export function readSelectedKnowledgeModelKey(): string {
  try { return localStorage.getItem(selectedKnowledgeModelStorageKey) ?? ''; }
  catch { return ''; }
}

export function saveSelectedKnowledgeModelKey(key: string) {
  try {
    localStorage.setItem(selectedKnowledgeModelStorageKey, key);
    return true;
  } catch { return false; }
}
