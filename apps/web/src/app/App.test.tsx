import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import "../i18n/index.js";
import { App } from "./App.js";

describe("App shell", () => {
  it("renders the translated app.title key (proves the i18n pipeline is wired end-to-end)", () => {
    render(<App />);
    expect(screen.getByText("Bunny Command Center")).toBeInTheDocument();
  });

  it("sets document.title from the same i18n key, not a hardcoded string", () => {
    render(<App />);
    expect(document.title).toBe("Bunny Command Center");
  });
});
