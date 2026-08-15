// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import i18next from "eslint-plugin-i18next";

/**
 * Attributes whose value a user (or a screen-reader user) actually reads. These are the ones
 * DASHBOARD/19_I18N_FR_EN_DE.md §Enforcement item 3 names: "an ESLint rule
 * (`i18next/no-literal-string` or equivalent) flags raw string literals inside JSX text
 * nodes/`aria-label` props not wrapped in `t()`".
 *
 * `exclude` is deliberately empty: with a non-empty `include` and an empty `exclude` the plugin
 * checks ONLY the listed attributes. Leaving the plugin's default `exclude` in place would
 * instead check every attribute that is not on its own denylist, which flags `data-testid`,
 * `href`, `role` and every other machine-facing value.
 */
const USER_VISIBLE_JSX_ATTRIBUTES = [
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "alt",
  "title",
  "placeholder",
  "label",
  "helperText",
];

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "vendor/**"],
  },
  js.configs.recommended,
  {
    // Type-aware linting only applies to TS files that belong to a real
    // tsconfig project - this root eslint.config.js itself is plain JS
    // config, not part of any app/package's tsconfig, and doesn't need it.
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // ---------------------------------------------------------------------
    // No hardcoded visible strings (D-019, 19_I18N_FR_EN_DE.md §Enforcement 3)
    // ---------------------------------------------------------------------
    files: ["apps/web/src/**/*.tsx"],
    ignores: ["apps/web/src/**/__tests__/**", "apps/web/src/**/*.test.tsx"],
    plugins: { i18next },
    rules: {
      "i18next/no-literal-string": [
        "error",
        {
          // Checks JSX text nodes AND the attributes listed below. `jsx-text-only` (the
          // plugin default) would miss `aria-label`, which 19_I18N_FR_EN_DE.md names
          // explicitly.
          mode: "jsx-only",
          "jsx-attributes": { include: USER_VISIBLE_JSX_ATTRIBUTES, exclude: [] },
          // <Trans> exists to hold markup around translated text; its children are the
          // translation, not a hardcoded string.
          "jsx-components": { exclude: ["Trans"] },
          words: {
            // Punctuation-only and SCREAMING_CASE fragments are not prose. Numerals are
            // covered by the first pattern (the design-system showcase renders a sample
            // hero number, which is data, not copy).
            exclude: ["[0-9!-/:-@[-`{-~]+", "[A-Z_-]+"],
          },
          message:
            "Visible strings must come from packages/shared/i18n via t() - see DASHBOARD/19_I18N_FR_EN_DE.md and 00_GLOBAL_IMPLEMENTATION_RULES.md #12.",
        },
      ],
    },
  },
  {
    // ---------------------------------------------------------------------
    // No raw colour literals outside the token layer
    // ---------------------------------------------------------------------
    // 20_DESIGN_SYSTEM_AND_THEMES.md's whole token architecture collapses the moment a
    // component hardcodes a colour: that component silently stops responding to the theme and
    // to the mode, and the contrast gate - which only ever sees the tokens - cannot detect it.
    // The token modules, the WCAG maths, and the tests are the only places a colour literal is
    // meaningful.
    files: ["apps/web/src/**/*.ts", "apps/web/src/**/*.tsx"],
    ignores: [
      "apps/web/src/theme/tokens/**",
      "apps/web/src/theme/contrast.ts",
      "apps/web/src/theme/preload/**",
      "apps/web/src/theme/validatedStorageManager.ts",
      "apps/web/src/**/__tests__/**",
      "apps/web/src/**/*.test.ts",
      "apps/web/src/**/*.test.tsx",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/]",
          message:
            "Raw colour literal. Use a theme token (theme.vars.palette.* / theme.bcc.*) so the value follows the active theme and mode and is covered by the WCAG contrast gate.",
        },
        {
          selector: "Literal[value=/^(?:rgba?|hsla?)\\(/]",
          message:
            "Raw colour literal. Use a theme token (theme.vars.palette.* / theme.bcc.*) so the value follows the active theme and mode and is covered by the WCAG contrast gate.",
        },
      ],
    },
  },
  eslintConfigPrettier,
);
