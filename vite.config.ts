import { defineConfig } from "vite";

export default defineConfig({
  // Must match the GitHub Pages project path: https://<user>.github.io/ekg-view/
  base: "/ekg-view/",
  server: {
    port: 5174,
    proxy: {
      // PhysioNet has no browser CORS — proxy API + WFDB files in local/dev.
      "/physionet": {
        target: "https://physionet.org",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/physionet/, ""),
      },
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/physionet": {
        target: "https://physionet.org",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/physionet/, ""),
      },
    },
  },
});
