import { build } from "esbuild";

await build({
  entryPoints: ["app/ontology-graph-client.ts"],
  bundle: true,
  format: "iife",
  minify: true,
  platform: "browser",
  target: "es2022",
  outfile: "dist/app/ontology-graph-client.js"
});
