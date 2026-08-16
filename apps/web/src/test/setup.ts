import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { installMatchMediaMock, resetMatchMediaMock } from "./matchMedia.js";
import { installInertEventSourceStub } from "./eventSourceMock.js";

// Every test starts from the same media state and the same empty storage, so a test that
// stores a theme preference cannot leak into the next one's "first visit" assertions.
beforeEach(() => {
  resetMatchMediaMock();
  installMatchMediaMock();
  installInertEventSourceStub();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-bcc-theme");
  document.documentElement.removeAttribute("data-bcc-color-scheme");
  document.documentElement.setAttribute("lang", "en");
});

afterEach(() => {
  window.localStorage.clear();
});

/**
 * Fails the test itself when React logs its "not wrapped in act(...)" warning, instead of
 * letting it sit as easy-to-miss stderr noise on an otherwise-green run - which is exactly how
 * a real set of these (found on the real GitHub Actions runner, never reproduced locally
 * despite several attempts) went unnoticed here for a while.
 *
 * Deliberately narrow: this matches ONLY that one specific, stable React message (the literal
 * text React DOM has used for this warning for years), not `console.error` in general. A
 * blanket "fail on any console.error" guard was considered and rejected - `App.test.tsx`
 * already has its own test ("renders without a single console error across the whole mount")
 * that intentionally captures and asserts on `console.error` output by temporarily replacing
 * it; a global blanket interceptor would either double-count that test's own captures or need
 * special-case coordination with it, for a guard whose whole point is to be simple and hard to
 * defeat by accident. This narrow version composes with that test with no coordination needed:
 * when that test replaces `console.error` locally, it fully shadows this wrapper for its own
 * render (nothing to double-count), and restores this wrapper afterwards via its own `finally`.
 */
const originalConsoleError = console.error;
let capturedActWarnings: string[] = [];

beforeEach(() => {
  capturedActWarnings = [];
  console.error = (...args: unknown[]) => {
    const message = args[0];
    if (typeof message === "string" && message.includes("not wrapped in act(")) {
      capturedActWarnings.push(message);
    }
    originalConsoleError(...args);
  };
});

afterEach(() => {
  console.error = originalConsoleError;
  if (capturedActWarnings.length > 0) {
    throw new Error(
      `React logged ${capturedActWarnings.length} "not wrapped in act(...)" warning(s) during this test - a real state update happened outside anything React Testing Library is tracking:\n\n${capturedActWarnings.join("\n\n")}`,
    );
  }
});
