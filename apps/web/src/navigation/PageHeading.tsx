// 28_ACCESSIBILITY.md §Focus management: "Focus moves deliberately after
// navigation (route change moves focus to the new page's main heading, not
// left on a now-gone element)". Every screen renders exactly one
// `<PageHeading>` as its top-level `<h1>`; this is the ONE place that
// implements the focus-on-mount behavior, so no screen has to remember to
// wire it individually (mirrors this codebase's existing "one shared
// mechanism, not one per screen" convention, e.g. `useRealtimeAwareQueryOptions`).
import { useEffect, useRef } from "react";
import Typography from "@mui/material/Typography";

export function PageHeading({ text }: { text: string }): React.JSX.Element {
  const ref = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, [text]);

  return (
    <Typography
      component="h1"
      variant="h4"
      ref={ref}
      tabIndex={-1}
      sx={{ outline: "none", marginBlockEnd: 2 }}
    >
      {text}
    </Typography>
  );
}
