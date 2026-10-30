const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kopiaUI", {
  selectDirectory: function (onSelected, startPath) {
    ipcRenderer.invoke("select-dir", startPath).then((v) => {
      onSelected(v);
    });
  },
  browseDirectory: function (path) {
    ipcRenderer.invoke("browse-dir", path);
  },
});
