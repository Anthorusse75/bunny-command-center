import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach } from "vitest";
import { installMatchMediaMock, resetMatchMediaMock } from "./matchMedia.js";

// Every test starts from the same media state and the same empty storage, so a test that
// stores a theme preference cannot leak into the next one's "first visit" assertions.
beforeEach(() => {
  resetMatchMediaMock();
  installMatchMediaMock();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-bcc-theme");
  document.documentElement.removeAttribute("data-bcc-color-scheme");
  document.documentElement.setAttribute("lang", "en");
});

afterEach(() => {
  window.localStorage.clear();
});
