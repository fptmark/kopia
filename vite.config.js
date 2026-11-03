import { defineConfig } from "vite";
import { coverageConfigDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import eslint from "vite-plugin-eslint";
import { execSync } from "node:child_process";

function gitHash() {
  try {
    return execSync("git rev-parse --short HEAD").toString().trim();
  } catch {
    return "unknown";
  }
}

function isDirty() {
  try {
    execSync("git diff --quiet HEAD");
    return false;
  } catch {
    return true;
  }
}

// Deliberately no timestamp: this string ends up embedded in the built JS, which ends up embedded in the
// locally-built server binary via go:embed, which gets ad-hoc code-signed on every `make install-server` --
// a signature that changes on every build (even with no real code changes) makes macOS treat each deploy as
// a different app and silently revoke Full Disk Access. Git state alone means an unchanged tree produces an
// unchanged version string (and so, modulo other inputs, an unchanged binary and signature).
const UI_VERSION = `custom-${gitHash()}${isDirty() ? "-dirty" : ""}`;

export default defineConfig(() => {
  return {
    build: {
      outDir: "build",
      chunkSizeWarningLimit: 1000,
    },
    define: { __UI_VERSION__: JSON.stringify(UI_VERSION) },
    plugins: [react(), eslint()],
    test: {
      globals: true,
      environment: "jsdom",
      coverage: {
        exclude: ["**/build/**", ...coverageConfigDefaults.exclude],
      },
    },
    server: {
      port: 3000,
      host: "localhost",
      https: false,
      strictPort: true,
      open: true,
      proxy: {
        "/api": {
          target: "http://localhost:51515",
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
