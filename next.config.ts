import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['tesseract.js', 'sharp', 'playwright', 'cheerio'],
};

export default nextConfig;
