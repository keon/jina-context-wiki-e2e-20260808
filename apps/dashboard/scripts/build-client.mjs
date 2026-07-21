import { build } from "esbuild";

await build({
  entryPoints: ["app/context-graph-client.ts"],
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: "es2022",
  outfile: "dist/app/context-graph-client.js"
});
