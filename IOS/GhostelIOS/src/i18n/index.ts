/**
 * i18n initialization for ghostel.app.
 *
 * Storage strategy:
 *  - User-selected language is persisted in AsyncStorage under key `ghostel:lang`
 *  - On first launch, defaults to English unless the user already chose a language
 *  - Supported: 'en' (default), 'pl'
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import AsyncStorage from '@react-native-async-storage/async-storage';
import en from './locales/en';
import pl from './locales/pl';

export const LANG_STORAGE_KEY = 'ghostel:lang';
export const SUPPORTED_LANGS = ['en', 'pl'] as const;
export type AppLang = (typeof SUPPORTED_LANGS)[number];

let _initialized = false;

function ensureI18nInitializedSync(initial: AppLang) {
  if (_initialized || i18n.isInitialized) {
    _initialized = true;
    return;
  }

  i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      pl: { translation: pl },
    },
    lng: initial,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    returnNull: false,
    compatibilityJSON: 'v4',
    // Needed for static web rendering path that uses renderToString.
    initAsync: false,
  });
  _initialized = true;
}

ensureI18nInitializedSync('en');

export async function initI18n(): Promise<AppLang> {
  let saved: AppLang | null = null;
  try {
    const raw = await AsyncStorage.getItem(LANG_STORAGE_KEY);
    if (raw && SUPPORTED_LANGS.includes(raw as AppLang)) {
      saved = raw as AppLang;
    }
  } catch {
    /* ignore */
  }
  const initial = saved || 'en';

  ensureI18nInitializedSync(initial);
  await i18n.changeLanguage(initial);
  return initial;
}

export async function setAppLanguage(lang: AppLang) {
  try {
    await AsyncStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    /* ignore */
  }
  await i18n.changeLanguage(lang);
}

export function currentLanguage(): AppLang {
  const lng = (i18n.language || 'en').slice(0, 2).toLowerCase();
  return SUPPORTED_LANGS.includes(lng as AppLang) ? (lng as AppLang) : 'en';
}

export default i18n;
