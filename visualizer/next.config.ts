import path from "path";
import type { NextConfig } from "next";
import packageJson from "./package.json";

// The Clio viewer imports framework-free modules from ../apps and ../packages
// (the @clio-viewer/* and @clio/protocol paths in tsconfig.json). Any `three`
// in the bundle, whoever imports it, resolves to this app's copy: the headset
// has its own, newer one. Subpaths follow three's package exports.
const three = path.join(__dirname, "node_modules/three");

const nextConfig: NextConfig = {
  devIndicators: false,
  // A second dev server or build can write elsewhere (NEXT_DIST_DIR=.next-e2e).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Keep this Bun app isolated from Clio's parent pnpm workspace during tracing.
  outputFileTracingRoot: __dirname,
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  transpilePackages: ["three"],
  // Avoid the 200-800ms cold-start cost of barrel-file imports.
  // react-icons re-exports thousands of icon components from /fa, etc.;
  // recharts and @huggingface/hub also have wide entry surfaces.
  experimental: {
    optimizePackageImports: ["react-icons", "recharts", "@huggingface/hub"],
    // Compile the shared Clio sources outside this folder.
    externalDir: true,
  },
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      three$: path.join(three, "build/three.module.js"),
      "three/addons$": path.join(three, "examples/jsm/Addons.js"),
      "three/addons": path.join(three, "examples/jsm"),
      "three/webgpu$": path.join(three, "build/three.webgpu.js"),
      "three/tsl$": path.join(three, "build/three.tsl.js"),
      three,
    };
    return config;
  },
  generateBuildId: () => packageJson.version,
};

export default nextConfig;
