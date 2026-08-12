import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./i18n/index.js";
import { App } from "./app/App.js";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root element not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
