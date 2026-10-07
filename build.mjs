import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir);
for (const file of ["manifest.json", "src/content.css", "src/options.html", "src/options.css"]) {
  await cp(file, `${outdir}/${file.split("/").pop()}`);
}

const options = {
  entryPoints: ["src/background.js", "src/content.js", "src/options.js"],
  outdir,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "firefox142",
  logLevel: "info",
};

if (watch) {
  await (await esbuild.context(options)).watch();
} else {
  await esbuild.build(options);
}
