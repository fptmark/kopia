import { use, useEffect, useRef, useState } from "react";
import { UIPreferencesContext } from "../../contexts/UIPreferencesContext";

function toDraft(prefs) {
  return {
    theme: prefs.theme === "dark" ? "dark" : "light",
    fontSize: prefs.fontSize,
    bytesStringBase2: !!prefs.bytesStringBase2,
    pageSize: prefs.pageSize,
    dateFormat: prefs.dateFormat || "medium",
    keepAwake: prefs.keepAwake === "ac" ? "ac" : "idle",
    verifyNewData: !!prefs.verifyNewData,
    verifyEachMode: prefs.verifyEachMode || "new",
    verifyEachPercent: prefs.verifyEachPercent || 10,
    storageStallTimeoutSeconds: prefs.storageStallTimeoutSeconds || 30,
    wakeGraceMinutes: Math.round((prefs.wakeGraceSeconds || 300) / 60),
  };
}

/**
 * The Settings tab's fields as a local draft: nothing reaches the preferences store (and so the server)
 * until save() is called. dirty is true while the draft differs from what is stored now.
 */
export function useSettingsDraft() {
  const prefs = use(UIPreferencesContext);
  const persisted = toDraft(prefs);
  const persistedJson = JSON.stringify(persisted);
  const [draft, setDraft] = useState(persisted);
  // true once the user has touched a field: stops the stored-preferences effect below from clobbering an
  // in-progress edit (the preferences load asynchronously, so draft starts out at a placeholder default and
  // must pick up the real values once they arrive -- but only before any edit of its own).
  const touchedRef = useRef(false);

  useEffect(() => {
    if (!touchedRef.current) {
      setDraft(persisted);
    }
    // persistedJson is what actually identifies a change here
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [persistedJson]);

  const change = (patch) => {
    touchedRef.current = true;
    setDraft((d) => ({ ...d, ...patch }));
  };

  const dirty = JSON.stringify(draft) !== persistedJson;

  const save = () => {
    if (draft.theme !== persisted.theme) {
      prefs.setTheme(draft.theme);
    }
    if (draft.fontSize !== persisted.fontSize) {
      prefs.setFontSize(draft.fontSize);
    }
    if (draft.bytesStringBase2 !== persisted.bytesStringBase2) {
      prefs.setByteStringBase(String(draft.bytesStringBase2));
    }
    if (draft.pageSize !== persisted.pageSize) {
      prefs.setPageSize(draft.pageSize);
    }
    if (draft.dateFormat !== persisted.dateFormat) {
      prefs.setDateFormat(draft.dateFormat);
    }
    if (draft.keepAwake !== persisted.keepAwake) {
      prefs.setKeepAwake(draft.keepAwake);
    }
    if (draft.verifyNewData !== persisted.verifyNewData) {
      prefs.setVerifyNewData(draft.verifyNewData);
    }
    if (draft.verifyEachMode !== persisted.verifyEachMode || draft.verifyEachPercent !== persisted.verifyEachPercent) {
      prefs.setVerifyEach(draft.verifyEachMode, draft.verifyEachPercent);
    }
    if (draft.storageStallTimeoutSeconds !== persisted.storageStallTimeoutSeconds) {
      prefs.setStorageStallTimeoutSeconds(draft.storageStallTimeoutSeconds);
    }
    if (draft.wakeGraceMinutes !== persisted.wakeGraceMinutes) {
      prefs.setWakeGraceSeconds(draft.wakeGraceMinutes * 60);
    }
    touchedRef.current = false;
    return Promise.resolve();
  };

  const discard = () => {
    touchedRef.current = false;
    setDraft(persisted);
  };

  return { draft, change, dirty, save, discard };
}
