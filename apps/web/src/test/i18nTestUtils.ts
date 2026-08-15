import { act, screen } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import i18next from "../i18n/index.js";

/**
 * Clicks a locale option and waits for the actual underlying async operation - i18next's own
 * `languageChanged` event - to complete, inside `act()`.
 *
 * Why this replaces a plain `waitFor`: the locale selector's click handler fires
 * `void i18n.changeLanguage(next)` without awaiting it (correctly - a UI click handler has
 * nothing useful to do with that promise). `changeLanguage` resolves asynchronously even with
 * every locale's resources already loaded, and it drives multiple independent subscribers
 * (`BccI18nProvider`, the selector itself, and whatever reads locale from context). A
 * `waitFor` on only one of those stops polling the instant THAT ONE condition is met - any
 * other subscriber's setState that lands on a later microtask is then unwrapped, which is
 * exactly the "not wrapped in act(...)" warning. Listening for `languageChanged` and awaiting
 * it inside `act(async () => ...)` ties the wait to the real async operation everything else
 * is downstream of, so `act` flushes every subscriber's update before the test proceeds - not
 * just the first one to settle.
 */
export async function clickLocaleOptionAndSettle(user: UserEvent, testId: string): Promise<void> {
  const languageChanged = new Promise<void>((resolve) => {
    i18next.once("languageChanged", () => resolve());
  });
  await user.click(screen.getByTestId(testId));
  await act(async () => {
    await languageChanged;
  });
}
