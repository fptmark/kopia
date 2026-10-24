import React from "react";
import { createRoot } from "react-dom/client";
import "./css/index.css";

// The rebuilt UI is served under /next while it is built; everything else is the existing UI. Each is loaded
// on its own so that neither one's global styles reach the other.
const isNext = /^\/next(\/|$)/.test(window.location.pathname);
const { default: App } = await import(isNext ? "./next/NextApp" : "./App");

const root = createRoot(document.getElementById("root"));
root.render(<App />);
