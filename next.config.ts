import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 對外走 Cloudflare Tunnel，dev 模式要放行這個 origin
  allowedDevOrigins: ["patracker.orblab.app"],
  // exceljs 與 pdfjs 內含動態 require／worker，交給 Node 直接載入不要打包
  serverExternalPackages: ["exceljs", "pdfjs-dist"],
};

export default nextConfig;
