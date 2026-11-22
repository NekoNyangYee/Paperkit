import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { finishBrowserPopup } from "@/features/auth/lib/browser-popup";
import "@/app/styles.css";

if (!finishBrowserPopup()) {
  void import("@/app/App").then(({ App }) => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
}
