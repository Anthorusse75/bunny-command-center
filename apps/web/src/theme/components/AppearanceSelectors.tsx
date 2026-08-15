// The theme, appearance-mode and language selectors.
//
// They live in Step 02 rather than waiting for the Profile screen because
// 28_ACCESSIBILITY.md §Keyboard names them explicitly as components that must be "reachable
// and operable via keyboard alone" ("including custom components: guild switcher, widget
// reorder list, upload item actions, theme/mode toggles"), and because the 9 theme x mode
// combinations cannot be verified end-to-end in a browser without a real control to drive.
// The Profile screen (SCREENS/PROFILE.md, a later step) composes these, it does not rewrite
// them.
//
// `ToggleButtonGroup` renders real <button>s with `aria-pressed` communicating the current
// choice, and Enter/Space activates the focused one - no custom key handling to get wrong.
// MUI 9's exclusive `ToggleButtonGroup` gives the group a real ARIA composite keyboard model
// (`@mui/utils/useRovingTabIndex`): Tab reaches ONE roving stop per group, and
// ArrowLeft/ArrowRight move the roving stop within it - the group is a single Tab stop, not
// three.
//
// `flexWrap: "wrap"` on every group: MUI's ToggleButtonGroup is a non-wrapping flex row by
// default, and German's longest label here - `common.mode.system` ("Systemeinstellung
// folgen", 24 characters) - does not fit three-across at the 320px minimum supported width
// (`MIN_SUPPORTED_VIEWPORT_PX`) under every font stack (21_MOBILE_UX.md/§29's "German
// expansion considered" requirement). Wrapping degrades to two rows instead of causing real
// page-level horizontal overflow; it does not change layout at any width the row already
// fits.

import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import { useTranslation } from "react-i18next";
import type { BccLocale } from "@bunny-command-center/shared";
import { useBccLocale } from "../../i18n/BccI18nProvider.js";
import { useBccMode, useBccThemeIdentity } from "../BccThemeProvider.js";
import { BCC_MODE_PREFERENCES, type BccModePreference, type BccThemeName } from "../tokens/types.js";

export function ThemeSelector(): React.JSX.Element {
  const { t } = useTranslation();
  const { themeName, setThemeName, availableThemes } = useBccThemeIdentity();

  return (
    <ToggleButtonGroup
      exclusive
      value={themeName}
      aria-label={t("a11y.themeSelector")}
      data-testid="theme-selector"
      size="small"
      sx={{ flexWrap: "wrap", rowGap: 1 }}
      onChange={(_event, next: BccThemeName | null) => {
        // `null` arrives when the user clicks the already-selected button; keeping the
        // current value stops the group from ever having no selection.
        if (next) {
          setThemeName(next);
        }
      }}
    >
      {availableThemes.map((name) => (
        <ToggleButton key={name} value={name} data-testid={`theme-option-${name}`}>
          {t(`common.theme.${name}`)}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export function ModeSelector(): React.JSX.Element {
  const { t } = useTranslation();
  const { modePreference, setModePreference } = useBccMode();

  return (
    <ToggleButtonGroup
      exclusive
      // Bound to the PREFERENCE, never to the resolved mode: binding it to the resolution
      // would turn a "system" choice into a hard "light"/"dark" choice on first render.
      value={modePreference}
      aria-label={t("a11y.modeSelector")}
      data-testid="mode-selector"
      size="small"
      sx={{ flexWrap: "wrap", rowGap: 1 }}
      onChange={(_event, next: BccModePreference | null) => {
        if (next) {
          setModePreference(next);
        }
      }}
    >
      {BCC_MODE_PREFERENCES.map((preference) => (
        <ToggleButton key={preference} value={preference} data-testid={`mode-option-${preference}`}>
          {t(`common.mode.${preference}`)}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export function LocaleSelector(): React.JSX.Element {
  const { t } = useTranslation();
  const { locale, setLocale, availableLocales } = useBccLocale();

  return (
    <ToggleButtonGroup
      exclusive
      value={locale}
      aria-label={t("a11y.languageSelector")}
      data-testid="locale-selector"
      size="small"
      sx={{ flexWrap: "wrap", rowGap: 1 }}
      onChange={(_event, next: BccLocale | null) => {
        if (next) {
          setLocale(next);
        }
      }}
    >
      {availableLocales.map((code) => (
        <ToggleButton key={code} value={code} data-testid={`locale-option-${code}`} lang={code}>
          {t(`common.language.${code}`)}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
