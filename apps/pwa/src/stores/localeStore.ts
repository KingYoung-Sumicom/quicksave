// SPDX-FileCopyrightText: 2026 King Young Technology
// SPDX-License-Identifier: MIT
import { create } from 'zustand';

export type LocalePref = 'auto' | 'en' | 'zh-TW';
export type ActiveLocale = 'en' | 'zh-TW';

const STORAGE_KEY = 'quicksave.localePref';

function loadPref(): LocalePref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'en' || raw === 'zh-TW' || raw === 'auto') return raw;
  } catch {
    // localStorage blocked — fall through to auto
  }
  return 'auto';
}

function detect(): ActiveLocale {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const raw of langs) {
    const tag = raw.toLowerCase();
    if (tag.startsWith('zh')) return 'zh-TW';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

function resolve(pref: LocalePref): ActiveLocale {
  return pref === 'auto' ? detect() : pref;
}

interface LocaleStore {
  pref: LocalePref;
  active: ActiveLocale;
  setPref: (pref: LocalePref) => void;
}

export const useLocaleStore = create<LocaleStore>((set) => {
  const pref = loadPref();
  return {
    pref,
    active: resolve(pref),
    setPref: (next) => {
      try {
        if (next === 'auto') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // ignore write failures
      }
      set({ pref: next, active: resolve(next) });
    },
  };
});
