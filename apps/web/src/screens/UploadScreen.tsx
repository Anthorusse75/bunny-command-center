// `/upload` — GLOBAL route (not guild-scoped, 03_INFORMATION_ARCHITECTURE.md).
// Real Bulk Upload infrastructure/UX is Steps 15/17's scope.
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function UploadScreen(): React.JSX.Element {
  return <PlaceholderScreen titleKey="upload.placeholder.title" bodyKey="upload.placeholder.body" />;
}
