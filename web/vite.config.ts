import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // ローカル開発では API（npm run dev:api）へプロキシし、本番の CloudFront と同じく同一オリジンにする
    proxy: { "/api": "http://localhost:8787" },
  },
});
