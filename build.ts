// Static build for GitHub Pages: bundle the app, then copy only the model/UI assets the game actually loads.
import { cpSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
const out = await Bun.build({ entrypoints: ["./index.html"], outdir: "./dist", minify: true });
if (!out.success) {
  console.error(out.logs.join("\n"));
  process.exit(1);
}
for (const p of [
  "UI_Pack",
  "KayKit_Platformer/Assets/gltf",
  "KayKit_Platformer/License.txt",
  "KayKit_Adventurers_Characters/Animations/gltf",
  "KayKit_Adventurers_Characters/Characters/gltf",
  "KayKit_Adventurers_Characters/Assets/gltf",
  "KayKit_Adventurers_Characters/License.txt",
]) cpSync(p, `dist/${p}`, { recursive: true });
writeFileSync("dist/.nojekyll", ""); // no Jekyll processing on Pages
console.log("built -> dist/");
