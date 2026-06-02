import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { I18nextProvider } from 'react-i18next';
import i18n, { initI18n, setAppLanguage, currentLanguage, AppLang } from './index';

type LanguageCtx = {
  lang: AppLang;
  setLang: (l: AppLang) => Promise<void>;
  ready: boolean;
};

const LanguageContext = createContext<LanguageCtx>({
  lang: 'en',
  setLang: async () => {},
  ready: false,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<AppLang>('en');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      const initial = await initI18n();
      setLangState(initial);
      setReady(true);
    })();
  }, []);

  const setLang = useCallback(async (l: AppLang) => {
    await setAppLanguage(l);
    setLangState(currentLanguage());
  }, []);

  return (
    <LanguageContext.Provider value={{ lang, setLang, ready }}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  return useContext(LanguageContext);
}
