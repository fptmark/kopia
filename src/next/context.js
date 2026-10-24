import React from "react";

/** What the shell knows and the pages may need: whether the repository is connected, its name, running tasks. */
export const NextContext = React.createContext({
  repoConnected: false,
  repoDescription: "",
  runningTasks: 0,
  refreshRepo: () => {},
});
