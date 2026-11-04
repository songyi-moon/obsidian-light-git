import esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["test/run.ts", "test/resilience.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outdir: "test/out",
  outExtension: { ".js": ".cjs" },
  external: ["obsidian"],
  logLevel: "warning",
});
