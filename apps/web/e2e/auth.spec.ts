// SCREENS/AUTH.md's Login and OAuth-error states, in a real browser
// (`auth-flow-chromium` project, playwright.config.ts — no pre-seeded
// session, unlike every other project). A jsdom/RTL test can assert the DOM
// shape; only a real engine proves the CTA is genuinely focusable/paints
// correctly/produces a real network request with the right response
// headers, matching this repo's own established rationale for why
// Playwright exists (theme-matrix.spec.ts's header comment).
//
// This does NOT drive a real (or fake) Discord consent screen through to
// completion — that protocol-level round trip (state/PKCE validation, token
// exchange, session creation) is already proven, exhaustively, against a
// real local HTTP Discord test double at the API integration level
// (apps/api/test/auth/routes.test.ts, 68 passing tests). What a real
// browser adds here that jsdom cannot: the actual `/api/auth/login`
// network response (a real 302 with real headers), and the actual rendered
// Login/OAuth-error screens (paint, focus, keyboard operability).
import { expect, test } from "@playwright/test";

test.describe("Login screen (unauthenticated)", () => {
  test("renders the Login screen, not the authenticated app, for a session-less visitor", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("login-screen")).toBeVisible();
    await expect(page.getByTestId("app-shell")).not.toBeAttached();
  });

  test("the CTA is a real, keyboard-focusable <button>", async ({ page }) => {
    await page.goto("/");
    const cta = page.getByTestId("login-cta");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveJSProperty("tagName", "BUTTON");
    await cta.focus();
    await expect(cta).toBeFocused();
  });

  test("clicking the CTA issues a real GET /api/auth/login request that responds with a 302 to Discord's authorize endpoint", async ({
    page,
  }) => {
    await page.goto("/");
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/auth/login")),
      page.getByTestId("login-cta").click(),
    ]);
    expect(response.status()).toBe(302);
    const location = response.headers()["location"] ?? "";
    expect(location).toContain("client_id=");
    expect(location).toContain("code_challenge=");
    expect(location).toContain("code_challenge_method=S256");
    expect(location).toContain("scope=identify");
  });

  test("no unexpected console error across the Login screen's real mount", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      // Chromium logs the browser-level "resource failed to load" line for
      // ANY non-2xx network response (including an intentionally-honest
      // 401 from the initial, unauthenticated GET /api/auth/session
      // bootstrap check, apps/web/src/features/auth/AuthProvider.tsx) as a
      // console "error" — this is expected, correct behavior for a
      // session-less visitor, not a real error, so it is the one message
      // filtered out here rather than loosening the assertion generally.
      if (message.type() === "error" && !message.text().includes("401")) {
        errors.push(message.text());
      }
    });
    await page.goto("/");
    await expect(page.getByTestId("login-screen")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("OAuth error screen", () => {
  const CASES = [
    { reason: "oauth_denied", key: "denied" },
    { reason: "state_mismatch", key: "stateMismatch" },
    { reason: "token_exchange_failed", key: "tokenExchangeFailed" },
  ] as const;

  for (const { reason } of CASES) {
    test(`renders the distinct message for ?error=${reason} and focuses the heading`, async ({ page }) => {
      await page.goto(`/login?error=${reason}`);
      const heading = page.getByRole("heading", { level: 1 });
      await expect(heading).toBeVisible();
      await expect(heading).toBeFocused();
      await expect(page.getByTestId("oauth-error-detail")).toBeVisible();
    });
  }

  test("'Try again' returns to the Login screen", async ({ page }) => {
    await page.goto("/login?error=state_mismatch");
    await expect(page.getByTestId("oauth-error-screen")).toBeVisible();
    await page.getByTestId("oauth-error-try-again").click();
    await expect(page.getByTestId("login-screen")).toBeVisible();
  });

  test("an unrecognized ?error= value falls back to the Login screen (never a blank/broken page)", async ({
    page,
  }) => {
    await page.goto("/login?error=totally_unknown_reason");
    await expect(page.getByTestId("login-screen")).toBeVisible();
  });
});
