// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT

export const SETTINGS_CATEGORIES = [
  { id: 'general', group: 'preferences', icon: 'sliders', titleId: 'settings.category.general', descriptionId: 'settings.category.general.description' },
  { id: 'ai-git', group: 'preferences', icon: 'sparkles', titleId: 'settings.category.aiGit', descriptionId: 'settings.category.aiGit.description' },
  { id: 'voice', group: 'preferences', icon: 'microphone', titleId: 'settings.category.voice', descriptionId: 'settings.category.voice.description' },
  { id: 'machines', group: 'connections', icon: 'computer', titleId: 'settings.category.machines', descriptionId: 'settings.category.machines.description' },
  { id: 'sync', group: 'connections', icon: 'shield', titleId: 'settings.category.sync', descriptionId: 'settings.category.sync.description' },
  { id: 'storage', group: 'data', icon: 'database', titleId: 'settings.category.storage', descriptionId: 'settings.category.storage.description' },
] as const;

export type SettingsCategoryId = typeof SETTINGS_CATEGORIES[number]['id'];

export function settingsCategoryFromPath(pathname: string): SettingsCategoryId {
  if (pathname.startsWith('/settings/m/')) return 'machines';
  const segment = pathname.split('/')[2];
  return SETTINGS_CATEGORIES.find((category) => category.id === segment)?.id ?? 'general';
}
