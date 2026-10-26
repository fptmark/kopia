import React, { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import axios from "axios";
import { setSummaryDateFormat } from "../next/format";

export const PAGE_SIZES = [10, 20, 30, 40, 50, 100];
export const UIPreferencesContext = React.createContext<UIPreferences>({} as UIPreferences);

const DEFAULT_PREFERENCES = {
  pageSize: PAGE_SIZES[0],
  bytesStringBase2: false,
  defaultSnapshotViewAll: false,
  theme: getDefaultTheme(),
  preferWebDav: false,
  fontSize: "fs-6",
  keepAwake: "never",
} as SerializedUIPreferences;
const PREFERENCES_URL = "/api/v1/ui-preferences";

export type Theme = "light" | "dark" | "pastel" | "ocean";
export type PageSize = 10 | 20 | 30 | 40 | 50 | 100;
export type FontSize = "fs-6" | "fs-5" | "fs-4";
export type KeepAwake = "never" | "idle" | "ac";

export interface UIPreferences {
  get pageSize(): PageSize;
  get theme(): Theme;
  get bytesStringBase2(): boolean;
  get defaultSnapshotViewAll(): boolean;
  get fontSize(): FontSize;
  get keepAwake(): KeepAwake;
  get verifierIMessageTo(): string;
  get verifyNewData(): boolean;
  get dateFormat(): string;
  get verifyEachMode(): string;
  get verifyEachPercent(): number;
  setTheme: (theme: Theme) => void;
  setPageSize: (pageSize: number) => void;
  setByteStringBase: (bytesStringBase2: string) => void;
  setDefaultSnapshotViewAll: (defaultSnapshotViewAll: boolean) => void;
  setFontSize: (size: string) => void;
  setKeepAwake: (keepAwake: string) => void;
  setVerifierIMessageTo: (to: string) => void;
  setVerifyNewData: (on: boolean) => void;
  setDateFormat: (format: string) => void;
  setVerifyEach: (mode: string, percent: number) => void;
}

interface SerializedUIPreferences {
  pageSize?: number;
  bytesStringBase2?: boolean;
  defaultSnapshotViewAll?: boolean;
  theme: Theme;
  fontSize: FontSize;
  keepAwake?: KeepAwake;
  verifierIMessageTo?: string;
  verifyNewData?: boolean;
  verifyEachMode?: string;
  verifyEachPercent?: number;
  dateFormat?: string;
}

export interface UIPreferenceProviderProps {
  children: ReactNode;
  initalValue: UIPreferences | undefined;
}

/**
 * Returns a default theme based on the user's browser settings.
 * @returns Theme
 */
function getDefaultTheme(): Theme {
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function normalizePageSize(pageSize: number): PageSize {
  for (let index = 0; index < PAGE_SIZES.length; index++) {
    const element = PAGE_SIZES[index];
    if (pageSize === element) {
      return pageSize as PageSize;
    }
    if (pageSize < element) {
      if (index === 0) {
        return element as PageSize;
      }
      return PAGE_SIZES[index - 1] as PageSize;
    }
  }
  return 100;
}

export function UIPreferenceProvider(props: UIPreferenceProviderProps) {
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  // What the server has. Nothing is saved before the stored preferences have been read, and only what
  // differs from the server's copy is saved. Saving the built-in defaults while the stored preferences were
  // still loading overwrote them (several tabs reloading together, as after a server restart, lost settings).
  const savedJsonRef = useRef<string | null>(null);

  const setTheme = useCallback(
    (theme: Theme) =>
      setPreferences((oldPreferences) => {
        syncTheme(theme, oldPreferences.fontSize);
        return { ...oldPreferences, theme };
      }),
    [],
  );

  const setPageSize = (pageSize: PageSize) =>
    setPreferences((oldPreferences) => {
      return { ...oldPreferences, pageSize };
    });

  const setByteStringBase = (input: string) =>
    setPreferences((oldPreferences) => {
      const bytesStringBase2 = input === "true";
      return { ...oldPreferences, bytesStringBase2 };
    });

  const setDefaultSnapshotViewAll = (input: boolean) =>
    setPreferences((oldPreferences) => {
      return { ...oldPreferences, defaultSnapshotViewAll: input };
    });

  const setKeepAwake = (input: string) =>
    setPreferences((oldPreferences) => {
      return { ...oldPreferences, keepAwake: input as KeepAwake };
    });

  const setVerifyNewData = (input: boolean) =>
    setPreferences((oldPreferences) => {
      return { ...oldPreferences, verifyNewData: input };
    });

  const setDateFormat = (dateFormat: string) =>
    setPreferences((oldPreferences) => {
      return { ...oldPreferences, dateFormat };
    });

  const setVerifyEach = (verifyEachMode: string, verifyEachPercent: number) =>
    setPreferences((oldPreferences) => {
      return { ...oldPreferences, verifyEachMode, verifyEachPercent };
    });

  const setVerifierIMessageTo = (input: string) =>
    setPreferences((oldPreferences) => {
      return { ...oldPreferences, verifierIMessageTo: input };
    });

  const setFontSize = useCallback(
    (fontSize: FontSize) =>
      setPreferences((oldPreferences) => {
        syncTheme(oldPreferences.theme, fontSize);
        return { ...oldPreferences, fontSize };
      }),
    [],
  );

  useEffect(() => {
    axios
      .get(PREFERENCES_URL)
      .then((result) => {
        const storedPreferences = result.data as SerializedUIPreferences;
        if (!storedPreferences.theme || (storedPreferences.theme as string) === "") {
          storedPreferences.theme = getDefaultTheme();
        }
        if (!storedPreferences.fontSize || (storedPreferences.fontSize as string) === "") {
          storedPreferences.fontSize = DEFAULT_PREFERENCES.fontSize;
        }
        if (!storedPreferences.pageSize || storedPreferences.pageSize === 0) {
          storedPreferences.pageSize = DEFAULT_PREFERENCES.pageSize;
        } else {
          storedPreferences.pageSize = normalizePageSize(storedPreferences.pageSize);
        }
        savedJsonRef.current = JSON.stringify(storedPreferences);
        setTheme(storedPreferences.theme);
        setFontSize(storedPreferences.fontSize);
        setPreferences(storedPreferences);
      })
      .catch((err) => console.error(err));
  }, [setTheme, setFontSize]);

  // set during render so the first paint after a change already uses the new format
  setSummaryDateFormat(preferences.dateFormat ?? "medium");

  useEffect(() => {
    if (!preferences || savedJsonRef.current === null) {
      return; // the stored preferences have not been read yet
    }
    const json = JSON.stringify(preferences);
    if (json === savedJsonRef.current) {
      return; // unchanged
    }
    savedJsonRef.current = json;
    axios
      .put(PREFERENCES_URL, preferences)
      .then((_result) => {})
      .catch((err) => console.error(err));
  }, [preferences]);

  /**
   * Synchronizes the theme as well as the font size with the class.
   * To prevent any situations, where the theme or the font size is not in sync with the class,
   * we first remove every element and set them again.
   *
   * @param theme
   * The theme to be set
   * @param fontSize
   * The font size to be set
   */
  const syncTheme = (theme: Theme, fontSize: FontSize) => {
    const doc = document.querySelector("html")!;
    doc.classList.remove(...doc.classList);
    doc.classList.add(theme, fontSize);
  };

  const providedValue = {
    ...preferences,
    setTheme,
    setPageSize,
    setByteStringBase,
    setDefaultSnapshotViewAll,
    setFontSize,
    setKeepAwake,
    setVerifierIMessageTo,
    setVerifyNewData,
    setVerifyEach,
    setDateFormat,
  } as UIPreferences;

  return <UIPreferencesContext value={providedValue}>{props.children}</UIPreferencesContext>;
}
