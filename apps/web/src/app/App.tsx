import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import CssBaseline from "@mui/material/CssBaseline";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";

export function App(): React.JSX.Element {
  const { t } = useTranslation();
  const title = t("app.title");

  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <>
      <CssBaseline />
      <Box
        component="main"
        sx={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center" }}
      >
        <Typography variant="h1" sx={{ fontSize: "1.5rem" }}>
          {title}
        </Typography>
      </Box>
    </>
  );
}
