// `/admin/platform` — Superadmin-only (see SuperadminRouteGuard.tsx). Real
// content is Step 11's scope.
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function SuperadminScreen(): React.JSX.Element {
  return <PlaceholderScreen titleKey="superadmin.placeholder.title" bodyKey="superadmin.placeholder.body" />;
}
