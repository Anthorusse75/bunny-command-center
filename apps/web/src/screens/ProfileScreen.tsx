// `/profile` — GLOBAL route. Real language/theme/guild-preferences settings
// UI is a later step's scope (the theme/language selectors already exist as
// standalone components, `theme/components/AppearanceSelectors.tsx` — this
// screen doesn't wire them together yet).
import { PlaceholderScreen } from "./PlaceholderScreen.js";

export function ProfileScreen(): React.JSX.Element {
  return <PlaceholderScreen titleKey="profile.placeholder.title" bodyKey="profile.placeholder.body" />;
}
