// GenClass goes first, before React Router hydrates, so it is installed before your app and its state are created.
// "@genclass/runtime/auto" observes (reports what it sees, never changes anything). To let it act, switch to
// "@genclass/runtime/auto/guard". Add ?genclass=off to the URL to turn it off for a page load.
import genclass from "@genclass/runtime/auto";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});

// The devtools overlay, in development only (not in your production bundle).
if (import.meta.env.DEV) import("@genclass/runtime/devtools").then((d) => d.mountDevtools(genclass));
