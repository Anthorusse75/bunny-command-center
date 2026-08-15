// Canonical i18n namespace list.
//
// Source of truth: DASHBOARD/19_I18N_FR_EN_DE.md §Key structure, which lists the
// namespaces mirroring the navigation domains of 03_INFORMATION_ARCHITECTURE.md.
// Every namespace below MUST exist as an object in all three locale catalogs even
// while empty - the i18n lint gate checks namespace presence structurally, so a
// later step cannot silently drop one.
//
// `POPULATED_IN_STEP_02` are the namespaces Step 02 owns and fills with real
// content. `RESERVED_FOR_LATER_STEPS` are intentionally empty objects, populated
// by their owning implementation step (IMPLEMENTATION/02_design_system_i18n.md:
// "feature namespaces like upload.* left as empty objects, populated by their
// owning step").

export const POPULATED_IN_STEP_02 = [
  // Step 01 introduced `app.title`; kept as-is, it is the document/product title.
  "app",
  "common",
  "errors",
  "a11y",
  // `showcase` is NOT one of 19_I18N_FR_EN_DE.md's navigation-domain namespaces.
  // It exists because Step 02's own deliverable (the design-system showcase and
  // responsive shell) is a rendered surface with visible strings, and
  // 00_GLOBAL_IMPLEMENTATION_RULES.md #12 forbids hardcoding any of them, while
  // writing them into a feature namespace owned by a later step would trespass.
  // Declared explicitly as a Step-02 addition rather than smuggled in.
  "showcase",
] as const;

export const RESERVED_FOR_LATER_STEPS = [
  "auth",
  "home",
  "upload",
  "guild",
  "premiumplus",
  "contributions",
  "leaderboard",
  "notifications",
  "onboarding",
  "adminGuild",
  "superadmin",
  "technical",
  "profile",
] as const;

export const I18N_NAMESPACES = [...POPULATED_IN_STEP_02, ...RESERVED_FOR_LATER_STEPS] as const;

export type I18nNamespace = (typeof I18N_NAMESPACES)[number];
