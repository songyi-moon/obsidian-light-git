// 브라우저에서 UI를 띄워보기 위한 최소 obsidian 스텁 (DOM 헬퍼 + Modal + setIcon + Notice)
type Opts = { cls?: string; text?: string; attr?: Record<string, string>; type?: string } | string;
const P = HTMLElement.prototype as any;
function applyOpts(el: HTMLElement, o?: Opts) {
	if (!o) return;
	if (typeof o === "string") return void (el.className = o);
	if (o.cls) el.className = o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.type) el.setAttribute("type", o.type);
	for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
}
P.createEl = function (tag: string, o?: Opts) {
	const el = document.createElement(tag);
	applyOpts(el, o);
	this.appendChild(el);
	return el;
};
P.createDiv = function (o?: Opts) { return this.createEl("div", o); };
P.createSpan = function (o?: Opts) { return this.createEl("span", o); };
P.empty = function () { this.innerHTML = ""; };
P.addClass = function (...c: string[]) { this.classList.add(...c); };
P.removeClass = function (...c: string[]) { this.classList.remove(...c); };
P.toggleClass = function (c: string, on: boolean) { this.classList.toggle(c, on); };
P.setText = function (t: string) { this.textContent = t; };
P.hide = function () { this.style.display = "none"; };
P.show = function () { this.style.display = ""; };
P.isShown = function () { return this.style.display !== "none"; };
P.createSvg = (Element.prototype as any).createSvg = function (tag: string, o?: { cls?: string; attr?: Record<string, string> }) {
	const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
	if (o?.cls) el.setAttribute("class", o.cls);
	for (const [k, v] of Object.entries(o?.attr ?? {})) el.setAttribute(k, v);
	this.appendChild(el);
	return el;
};

const ICONS: Record<string, string> = { "chevrons-right": "»", "chevrons-left": "«", x: "✕", "rotate-ccw": "↺" };
export function setIcon(el: HTMLElement, name: string) {
	const svg = (window as any).__ICONS?.[name];
	if (svg) el.innerHTML = svg.replace("<svg", '<svg class="svg-icon"');
	else el.textContent = ICONS[name] ?? name;
}
export class Notice { constructor(msg: string) { console.log("NOTICE:", msg); (window as any).__notices.push(msg); } }
/** Obsidian의 Scope처럼 맨 위 모달만 키를 받는다 */
const scopes: { mods: string[]; key: string; run: () => unknown }[][] = [];
document.addEventListener("keydown", (e) => {
	const mods = [["Shift", e.shiftKey], ["Alt", e.altKey], ["Ctrl", e.ctrlKey]].filter(([, on]) => on).map(([m]) => m);
	const hit = scopes[scopes.length - 1]?.find((s) => s.key === e.key && s.mods.join() === mods.join());
	if (hit && hit.run() === false) e.preventDefault();
});
export class Menu {
	items: string[] = [];
	addItem(cb: (i: any) => unknown) {
		const item: any = { setTitle: (t: string) => (this.items.push(t), (item.title = t), item), setIcon: () => item, onClick: (fn: () => void) => ((((window as any).__menuRun ??= {})[item.title] = fn), item) };
		cb(item);
		return this;
	}
	showAtMouseEvent() { (window as any).__menu = this.items; return this; }
}
export class Modal {
	modalEl: HTMLElement; contentEl: HTMLElement; titleEl: HTMLElement;
	private keys: { mods: string[]; key: string; run: () => unknown }[] = [];
	scope = { register: (mods: string[], key: string, run: () => unknown) => void this.keys.push({ mods, key, run }) };
	constructor(public app: unknown) {
		this.modalEl = document.createElement("div");
		this.modalEl.className = "modal";
		this.titleEl = (this.modalEl as any).createDiv({ cls: "modal-title" });
		this.contentEl = (this.modalEl as any).createDiv({ cls: "modal-content" });
	}
	setTitle(t: string) { this.titleEl.textContent = t; return this; }
	open() { document.body.querySelector(".modal-container")!.appendChild(this.modalEl); scopes.push(this.keys); (this as any).onOpen(); }
	close() { (this as any).onClose?.(); this.modalEl.remove(); scopes.splice(scopes.indexOf(this.keys), 1); (window as any).__closed = true; }
}
export class ItemView {
	contentEl: HTMLElement;
	app: any = { workspace: { on: () => ({}) } };
	registerEvent() {}
	registerDomEvent(el: EventTarget, type: string, fn: EventListener) { el.addEventListener(type, fn); }
	constructor(public leaf: unknown) {
		this.contentEl = document.createElement("div");
		this.contentEl.className = "view-content";
	}
}
/** 어떤 메서드를 불러도 자기 자신을 돌려주는 컴포넌트 (설정 화면용) */
const chain = (props: object) => {
	const c: any = new Proxy(props, { get: (t: any, k) => (k in t ? t[k] : () => c) });
	return c;
};
export class PluginSettingTab {
	containerEl = document.createElement("div");
	constructor(public app: unknown, public plugin: unknown) {}
}
export class Setting {
	constructor(public el: HTMLElement) {}
	setName() { return this; }
	setDesc() { return this; }
	setHeading() { return this; }
	addText(cb: (t: any) => unknown) {
		const inputEl = document.createElement("input");
		inputEl.type = "text";
		this.el.appendChild(inputEl);
		cb(chain({ inputEl }));
		return this;
	}
	addToggle(cb: (t: any) => unknown) { cb(chain({})); return this; }
	addDropdown(cb: (t: any) => unknown) { cb(chain({})); return this; }
	addButton(cb: (b: any) => unknown) {
		const el = document.createElement("button");
		this.el.appendChild(el);
		const b = {
			setButtonText(t: string) { el.textContent = t; return b; },
			setWarning() { return b; },
			setCta() { return b; },
			onClick(fn: () => void) { el.onclick = fn; return b; },
		};
		cb(b);
		return this;
	}
}
export type WorkspaceLeaf = unknown;
