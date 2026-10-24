import React from "react";
import { createRoot } from "react-dom/client";
import "./css/index.css";

// The rebuilt UI is served under /next while it is built; everything else is the existing UI. Each is a
// separate import so that the build splits them and neither one's global styles reach the other.
const isNext = /^\/next(\/|$)/.test(window.location.pathname);
const App = isNext ? (await import("./next/NextApp")).default : (await import("./App")).default;

const root = createRoot(document.getElementById("root"));
root.render(<App />);
