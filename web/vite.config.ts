import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  build: {
    // HEIC 変換ライブラリ（約 1.3MB）は HEIC を読めないブラウザでだけ遅延読み込みされる
    chunkSizeWarningLimit: 1500,
  },
  server: {
    // ローカル開発では API（npm run dev:api）へプロキシし、本番の CloudFront と同じく同一オリジンにする。
    // /photos・/prizes は写真・景品の画像の配信、/__dev は S3 への署名付き POST の代わり
    proxy: { "/api": api, "/photos": api, "/prizes": api, "/__dev": api },
  },
});
