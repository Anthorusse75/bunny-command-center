import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import fr from "@bunny-command-center/shared/i18n/fr.json";
import en from "@bunny-command-center/shared/i18n/en.json";
import de from "@bunny-command-center/shared/i18n/de.json";

void i18next.use(initReactI18next).init({
  resources: {
    fr: { translation: fr },
    en: { translation: en },
    de: { translation: de },
  },
  lng: "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18next;
