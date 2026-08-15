// The Step-02 showcase surface.
//
// 02_design_system_i18n.md §SCOPE forbids "any real page/route content", and §PROOF OF WIRING
// requires "load the app shell in a browser at each of the 9 theme x mode combinations and at
// both breakpoints -> effect: correct tokens applied, correct nav chrome shown". Those two
// together mean the shell needs exactly one non-route surface that exercises every primitive
// this step ships, and nothing else. That is this file: theme/mode/language controls, one
// StatusBadge per tone, the toast queue, the tooltip, the type scale, and the three surface
// levels. No product feature, no route, no data fetch.
//
// Every string comes from the `showcase.*` namespace (see
// packages/shared/src/i18n/namespaces.ts for why that namespace exists and why the feature
// namespaces were left untouched).

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";
import { STATUS_TONES, formatNumber, statusDescriptorForTone } from "@bunny-command-center/shared";
import { InfoTooltip, StatusBadge, useToast } from "../design-system/index.js";
import { LocaleSelector, ModeSelector, ThemeSelector } from "../theme/components/AppearanceSelectors.js";
import { useBccMode, useBccThemeIdentity } from "../theme/BccThemeProvider.js";
import { useBccLocale } from "../i18n/BccI18nProvider.js";

function Section({ titleKey, children }: { titleKey: string; children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <Box component="section" sx={{ marginBlockEnd: 4 }}>
      <Typography variant="h2" sx={{ marginBlockEnd: 1 }}>
        {t(titleKey)}
      </Typography>
      {children}
    </Box>
  );
}

export function DesignSystemShowcase(): React.JSX.Element {
  const { t } = useTranslation();
  const { themeName } = useBccThemeIdentity();
  const { resolvedMode } = useBccMode();
  const { locale } = useBccLocale();
  const { showToast } = useToast();

  return (
    <Box sx={{ maxWidth: 960, marginInline: "auto" }}>
      <Typography variant="h1">{t("showcase.title")}</Typography>
      <Typography variant="body1" sx={{ color: "text.secondary", marginBlockEnd: 3 }}>
        {t("showcase.subtitle")}
      </Typography>

      <Section titleKey="showcase.sections.appearance">
        <Typography variant="body2" sx={{ marginBlockEnd: 2 }}>
          {t("showcase.appearance.description")}
        </Typography>
        <Stack spacing={2} sx={{ alignItems: "flex-start" }}>
          <ThemeSelector />
          <ModeSelector />
          <LocaleSelector />
        </Stack>
        <Stack direction="row" spacing={2} useFlexGap sx={{ marginBlockStart: 2, flexWrap: "wrap" }}>
          {/* Readback for the proof-of-wiring chain: which theme and which RESOLVED mode
              actually ended up applied, rendered from the same state the tokens came from. */}
          <Typography variant="body2" data-testid="active-theme-readback">
            {t("showcase.activeTheme", { theme: t(`common.theme.${themeName}`) })}
          </Typography>
          <Typography variant="body2" data-testid="resolved-mode-readback">
            {t("showcase.resolvedMode", { mode: t(`common.mode.${resolvedMode}`) })}
          </Typography>
        </Stack>
      </Section>

      <Section titleKey="showcase.sections.statusBadges">
        <Typography variant="body2" sx={{ marginBlockEnd: 2 }}>
          {t("showcase.statusBadges.description")}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {STATUS_TONES.map((tone) => (
            <StatusBadge key={tone} descriptor={statusDescriptorForTone(tone)} />
          ))}
        </Stack>
      </Section>

      <Section titleKey="showcase.sections.toasts">
        <Typography variant="body2" sx={{ marginBlockEnd: 2 }}>
          {t("showcase.toasts.description")}
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          <Button
            variant="contained"
            data-testid="toast-info-button"
            onClick={() => showToast({ tone: "info", messageKey: "showcase.toasts.sampleInfo" })}
          >
            {t("showcase.toasts.info")}
          </Button>
          <Button
            variant="outlined"
            data-testid="toast-success-button"
            onClick={() => showToast({ tone: "success", messageKey: "showcase.toasts.sampleSuccess" })}
          >
            {t("showcase.toasts.success")}
          </Button>
          <Button
            variant="outlined"
            data-testid="toast-error-button"
            onClick={() => showToast({ tone: "error", messageKey: "showcase.toasts.sampleError" })}
          >
            {t("showcase.toasts.error")}
          </Button>
        </Stack>
      </Section>

      <Section titleKey="showcase.sections.tooltips">
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="body2">{t("showcase.tooltips.description")}</Typography>
          <InfoTooltip contentKey="showcase.tooltips.help" />
        </Stack>
      </Section>

      <Section titleKey="showcase.sections.typography">
        <Stack spacing={1}>
          {/*
            A hero number is data, not copy - so it goes through the shared Intl wrapper rather
            than being typed as literal JSX text. That also makes it a live demonstration that
            number formatting follows the selected language (FR/DE group with a space/dot where
            EN uses a comma), which 19_I18N_FR_EN_DE.md §Dates, numbers, relative time requires.
          */}
          <Typography variant="heroNumber" data-testid="type-hero-number">
            {formatNumber(locale, 1248)}
          </Typography>
          <Typography variant="overline">{t("showcase.typography.display")}</Typography>
          <Typography variant="h3">{t("showcase.typography.sample")}</Typography>
          <Typography variant="overline">{t("showcase.typography.body")}</Typography>
          <Typography variant="body1">{t("showcase.typography.sample")}</Typography>
          <Typography variant="body2">{t("showcase.typography.sample")}</Typography>
          <Typography variant="caption">{t("showcase.typography.sample")}</Typography>
        </Stack>
      </Section>

      <Section titleKey="showcase.sections.surfaces">
        <Stack spacing={2}>
          {[0, 1, 2, 3].map((level) => (
            <Paper key={level} elevation={level} data-testid={`surface-level-${level}`} sx={{ padding: 2 }}>
              <Typography variant="body2">{t("showcase.surfaces.level", { level })}</Typography>
            </Paper>
          ))}
        </Stack>
        <Divider sx={{ marginBlock: 2 }} />
      </Section>
    </Box>
  );
}
