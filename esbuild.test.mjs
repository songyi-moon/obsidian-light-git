import esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["test/run.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "test/out/run.cjs",
  external: ["obsidian"],
  logLevel: "warning",
});
