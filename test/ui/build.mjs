import esbuild from "esbuild";
import fs from "fs";
await esbuild.build({
  entryPoints: ["test/ui/harness.ts", "test/ui/views.ts"],
  bundle: true,
  format: "iife",
  outdir: "test/out/ui",
  alias: { obsidian: "./test/ui/obsidianStub.ts" },
  logLevel: "warning",
});
const vars = `:root{--background-primary:#fff;--background-primary-alt:#fafafa;--background-secondary:#f2f3f5;--background-modifier-border:#ddd;--background-modifier-hover:#eee;--text-normal:#222;--text-muted:#666;--text-faint:#999;--text-error:#e93147;--text-accent:#7852ee;--text-on-accent:#fff;--color-red:#e93147;--color-green:#08b94e;--color-blue:#086ddd;--color-red-rgb:233,49,71;--color-green-rgb:8,185,78;--color-blue-rgb:8,109,221;--color-yellow-rgb:224,172,0;--font-monospace:Consolas,monospace;--font-interface:'Segoe UI','Malgun Gothic',sans-serif;--font-ui-smaller:12px;--font-ui-small:13px;--font-ui-medium:15px;--font-semibold:600;--font-bold:700;--radius-s:4px;--radius-m:8px}
body{margin:0;font-family:var(--font-interface);color:var(--text-normal);background:#888}.modal-container{position:fixed;inset:0;display:flex;align-items:center;justify-content:center}
.modal{background:var(--background-primary);border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 4px 30px #0005}.modal-title{font-weight:600;padding:12px 16px}.modal-content{overflow:auto;padding:0 16px 16px;flex:1}
button{font:inherit;font-size:13px;padding:4px 10px;border:1px solid #ccc;border-radius:4px;background:#fff;cursor:pointer}button.mod-cta{background:var(--text-accent);color:#fff;border-color:var(--text-accent)}textarea{border:1px solid #ccc;border-radius:4px;box-sizing:border-box;background:var(--background-primary);color:var(--text-normal)}
button{background:var(--background-primary);color:var(--text-normal);border-color:var(--background-modifier-border)}
.clickable-icon{display:inline-flex;padding:4px;border-radius:4px;color:var(--text-muted)}.clickable-icon:hover{background:var(--background-modifier-hover);color:var(--text-normal)}.svg-icon{width:16px;height:16px}
body.theme-dark{--background-primary:#1e1e1e;--background-primary-alt:#242424;--background-secondary:#262626;--background-modifier-border:#363636;--background-modifier-hover:#2f2f2f;--text-normal:#dadada;--text-muted:#a8a8a8;--text-faint:#6e6e6e;--text-error:#fb464c;--text-accent:#a68af9;--color-red:#fb464c;--color-green:#44cf6e;--color-blue:#53a5ff;--color-red-rgb:251,70,76;--color-green-rgb:68,207,110;--color-blue-rgb:83,165,255;--interactive-accent:#8a5cf5;background:#111}
:root{--interactive-accent:#7852ee}`;
// Obsidian과 같은 Lucide 아이콘을 테스트 화면에도 (setIcon 스텁이 사용)
const iconDir = "node_modules/lucide-static/icons";
const icons = {};
for (const f of fs.readdirSync(iconDir)) icons[f.replace(/[.]svg$/, "")] = fs.readFileSync(iconDir + "/" + f, "utf8").replace(/<!--[^]*?-->/g, "").trim();
fs.writeFileSync("test/out/ui/icons.js", "window.__ICONS=" + JSON.stringify(icons));
const page = (js) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${vars}</style><link rel="stylesheet" href="../../../styles.css"></head><body><div class="modal-container"></div><script src="icons.js"></script><script>document.addEventListener("DOMContentLoaded",()=>{for(const f of location.hash.slice(1).split(",").filter(Boolean))document.body.classList.add(f==="dark"?"theme-dark":"is-"+f)})</script><script src="${js}"></script></body></html>`;
fs.writeFileSync("test/out/ui/index.html", page("harness.js"));
fs.writeFileSync("test/out/ui/views.html", page("views.js"));
