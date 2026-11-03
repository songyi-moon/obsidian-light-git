// 모바일 환경 흉내: obsidian 외의 모든 require를 막고, 전역 Buffer도 제거한 채 main.js 로드
const Module = require("module");
const orig = Module.prototype.require;
const blocked = [];
Module.prototype.require = function (id) {
  if (id === "obsidian") return new Proxy({}, { get: (_t, k) => (k === "Plugin" || k === "PluginSettingTab" || k === "Modal" ? class {} : k === "Platform" ? { isMobile: true } : function () {}) });
  if (this.filename && this.filename.endsWith("main.js")) { blocked.push(id); throw new Error("blocked require on mobile: " + id); }
  return orig.apply(this, arguments);
};
delete globalThis.Buffer;
const m = require("../main.js");
console.log("loaded OK, default export:", typeof m.default, "| Buffer polyfilled:", typeof globalThis.Buffer, "| blocked:", blocked);
