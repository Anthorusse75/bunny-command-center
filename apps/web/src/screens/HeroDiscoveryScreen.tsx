// `/admin/platform/hero-discovery` — Superadmin-only (see
// SuperadminRouteGuard.tsx). Real content is Step 20's scope.
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function HeroDiscoveryScreen(): React.JSX.Element {
  return (
    <PlaceholderScreen
      titleKey="superadmin.heroDiscovery.placeholder.title"
      bodyKey="superadmin.heroDiscovery.placeholder.body"
    />
  );
}
