import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/assets/",
  plugins: [react()],
  build: {
    // The HTTP app serves /assets/:name from the web root.
    outDir: "web",
    emptyOutDir: false,
    rollupOptions: {
      // merchant-login.js imports this entry as a module and calls its export.
      preserveEntrySignatures: "strict",
      input: "web/privy-login.tsx",
      output: {
        entryFileNames: "merchant-privy.js",
        chunkFileNames: "privy-[hash].js",
        assetFileNames: "privy-[name]-[hash][extname]",
      },
    },
  },
});
