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

const UI_VERSION = `custom-${gitHash()}-${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

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
