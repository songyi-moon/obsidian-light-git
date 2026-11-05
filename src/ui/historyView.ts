import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { CommitInfo } from "../git/types";
import type LightGitPlugin from "../main";
import { asButton, revealInList } from "./asButton";
import { commitGraph, type GraphRow } from "./commitGraph";
import { addPinButton } from "./pinButton";

export const HISTORY_VIEW = "light-git-history";
const PAGE = 50;
/** 이 폭 이상이면 IntelliJ Log처럼 목록 | 상세로 나눈다. 좁으면 커밋을 그 자리에서 펼친다 */
const WIDE = 640;
const GRAPH_ROW = 24;
const GRAPH_COL = 12;
const GRAPH_MAX_LANES = 8;

function pad(n: number) {
	return String(n).padStart(2, "0");
}

function relativeTime(sec: number): string {
	const diff = Date.now() / 1000 - sec;
	if (diff < 60) return "방금";
	if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
	if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
	const d = new Date(sec * 1000);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fullTime(sec: number): string {
	const d = new Date(sec * 1000);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class HistoryView extends ItemView {
	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private filterEl!: HTMLInputElement;
	private limit = PAGE;
	private commits: CommitInfo[] = [];
	private unpushed = new Set<string>();
	private selected: string | null = null;
	private wide = false;
	/** 마지막으로 고른 커밋의 상세만 그리도록 */
	private detailToken = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: LightGitPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return HISTORY_VIEW;
	}

	getDisplayText() {
		return "Git History";
	}

	getIcon() {
		return "history";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("light-git-view");
		const bar = root.createDiv({ cls: "light-git-toolbar" });
		bar.createDiv({ cls: "light-git-toolbar-title", text: "History" });
		this.filterEl = bar.createEl("input", { type: "search", cls: "light-git-history-filter", attr: { placeholder: "메시지·작성자·해시", "aria-label": "커밋 검색" } });
		this.filterEl.addEventListener("input", () => this.render());
		const refresh = bar.createDiv({ cls: "clickable-icon light-git-icon", attr: { "aria-label": "새로고침" } });
		setIcon(refresh, "refresh-cw");
		asButton(refresh, () => this.refresh());
		addPinButton(this, bar);
		const body = root.createDiv({ cls: "light-git-history-body" });
		this.listEl = body.createDiv({ cls: "light-git-list", attr: { tabindex: "0", role: "listbox", "aria-label": "커밋 목록" } });
		this.detailEl = body.createDiv({ cls: "light-git-commit-detail" });
		this.registerDomEvent(this.listEl, "keydown", (e) => this.onKey(e));
		await this.refresh();
	}

	onResize() {
		if (this.isWide() !== this.wide) this.render();
	}

	private isWide() {
		return this.contentEl.clientWidth >= WIDE && !document.body.classList.contains("is-mobile");
	}

	async refresh() {
		if (!this.listEl || this.plugin.isBusy()) return;
		try {
			const b = await this.plugin.getBackend();
			const repo = await b.isRepo();
			this.commits = repo ? await b.log(this.limit) : [];
			this.unpushed = new Set(repo ? await b.unpushedCommits() : []);
			await this.render();
		} catch (e) {
			this.listEl.empty();
			this.listEl.createDiv({ cls: "light-git-empty", text: `오류: ${e instanceof Error ? e.message : String(e)}` });
		}
	}

	private async render() {
		const scrollTop = this.listEl.scrollTop;
		this.listEl.empty();
		this.wide = this.isWide();
		this.contentEl.toggleClass("is-wide", this.wide);
		const query = this.filterEl.value.trim().toLowerCase();
		const shown = query ? this.commits.filter((c) => `${c.message}\n${c.author}\n${c.oid}`.toLowerCase().includes(query)) : this.commits;
		if (!shown.length) {
			this.listEl.createDiv({ cls: "light-git-empty", text: query ? "검색 결과 없음" : "커밋이 없습니다." });
			this.detailEl.empty();
			return;
		}
		// 그래프는 전체 목록과 넓은 화면에서만: 검색으로 건너뛴 커밋이 있으면 선이 이어지지 않는다
		const graph = this.wide && !query ? commitGraph(this.commits) : null;
		const lanes = graph ? Math.min(GRAPH_MAX_LANES, Math.max(...graph.map((g) => Math.max(g.lane, ...g.top.flat(), ...g.bottom.flat()))) + 1) : 0;
		shown.forEach((c, i) => this.commitRow(c, graph?.[i] ?? null, lanes));
		if (this.commits.length >= this.limit && !query) {
			const more = this.listEl.createEl("button", { cls: "light-git-more", text: "더 보기" });
			more.onclick = () => {
				this.limit += PAGE;
				this.refresh();
			};
		}
		this.listEl.scrollTop = scrollTop;
		if (!this.wide) return;
		const current = shown.find((c) => c.oid === this.selected) ?? shown[0];
		this.markSelected(current.oid);
		await this.showDetail(current);
	}

	private commitRow(c: CommitInfo, graph: GraphRow | null, lanes: number) {
		const item = this.listEl.createDiv({ cls: "light-git-commit", attr: { "data-oid": c.oid, role: "option" } });
		const head = item.createDiv({ cls: "light-git-commit-head" });
		if (graph) this.drawGraph(head, graph, lanes);
		head.createDiv({ cls: "light-git-commit-msg", text: c.message.split("\n")[0] });
		const meta = head.createDiv({ cls: "light-git-commit-meta" });
		if (this.unpushed.has(c.oid)) meta.createSpan({ cls: "light-git-status-unpushed", text: "↑ push 대기 · " });
		meta.createSpan({ text: `${c.author} · ${relativeTime(c.timestamp)} · ${c.oid.slice(0, 7)}` });
		if (c.oid === this.selected) item.addClass("is-selected");
		const files = item.createDiv({ cls: "light-git-commit-files" });
		files.hide();
		head.onclick = async () => {
			this.markSelected(c.oid);
			if (this.wide) return void (await this.showDetail(c));
			if (files.isShown()) return void files.hide();
			files.show();
			if (!files.childElementCount) await this.loadFiles(c, files);
		};
	}

	private drawGraph(parent: HTMLElement, g: GraphRow, lanes: number) {
		const x = (lane: number) => 7 + Math.min(lane, GRAPH_MAX_LANES - 1) * GRAPH_COL;
		const mid = GRAPH_ROW / 2;
		const svg = parent.createSvg("svg", { cls: "light-git-graph", attr: { width: String(lanes * GRAPH_COL + 2), height: String(GRAPH_ROW), "aria-hidden": "true" } });
		const line = ([from, to]: [number, number], y1: number, y2: number) => {
			svg.createSvg("line", { cls: `lane-${from % 4}`, attr: { x1: String(x(from)), y1: String(y1), x2: String(x(to)), y2: String(y2) } });
		};
		for (const l of g.top) line(l, 0, mid);
		for (const l of g.bottom) line(l, mid, GRAPH_ROW);
		svg.createSvg("circle", { cls: `lane-${g.lane % 4}`, attr: { cx: String(x(g.lane)), cy: String(mid), r: "3.5" } });
	}

	private markSelected(oid: string) {
		this.selected = oid;
		for (const el of Array.from(this.listEl.querySelectorAll<HTMLElement>(".light-git-commit"))) {
			const on = el.dataset.oid === oid;
			el.toggleClass("is-selected", on);
			el.setAttribute("aria-selected", String(on));
			if (on) revealInList(this.listEl, el);
		}
	}

	private onKey(e: KeyboardEvent) {
		if (e.target !== this.listEl) return;
		const items = Array.from(this.listEl.querySelectorAll<HTMLElement>(".light-git-commit"));
		const cur = items.findIndex((el) => el.dataset.oid === this.selected);
		const target = e.key === "ArrowDown" ? Math.min(cur + 1, items.length - 1) : e.key === "ArrowUp" ? Math.max(cur - 1, 0) : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
		if (target >= 0 && items[target]) {
			this.markSelected(items[target].dataset.oid!);
			const c = this.commits.find((x) => x.oid === this.selected);
			if (this.wide && c) void this.showDetail(c);
		} else if (e.key === "Enter" && cur >= 0) {
			// 넓은 화면은 첫 파일의 Diff를, 좁은 화면은 커밋을 펼친다
			const first = this.wide ? this.detailEl.querySelector<HTMLElement>(".light-git-file") : items[cur].querySelector<HTMLElement>(".light-git-commit-head");
			first?.click();
		} else return;
		e.preventDefault();
	}

	private async showDetail(c: CommitInfo) {
		const token = ++this.detailToken;
		const el = this.detailEl;
		el.empty();
		el.createDiv({ cls: "light-git-detail-message", text: c.message });
		el.createDiv({ cls: "light-git-detail-meta", text: `${c.author} · ${fullTime(c.timestamp)} · ${c.oid.slice(0, 10)}` });
		const files = el.createDiv({ cls: "light-git-commit-files" });
		await this.loadFiles(c, files, () => token === this.detailToken);
	}

	private async loadFiles(c: CommitInfo, el: HTMLElement, current: () => boolean = () => true) {
		el.createDiv({ cls: "light-git-hint", text: "불러오는 중…" });
		try {
			const b = await this.plugin.getBackend();
			const files = await b.commitFiles(c.oid);
			if (!current()) return;
			el.empty();
			if (!files.length) el.createDiv({ cls: "light-git-hint", text: "변경 파일 없음" });
			const paths = files.map((f) => f.path);
			for (const f of files) {
				// 변경 사항 뷰와 같은 모양: 상태는 파일명 색, 폴더는 흐리게
				const row = el.createDiv({ cls: `light-git-file type-${f.type}`, attr: { "aria-label": f.path } });
				const slash = f.path.lastIndexOf("/");
				const name = row.createDiv({ cls: "light-git-file-name" });
				name.createSpan({ cls: "light-git-file-base", text: f.path.slice(slash + 1) });
				if (slash > 0) name.createSpan({ cls: "light-git-file-dir", text: f.path.slice(0, slash) });
				row.onclick = () => this.plugin.openCommitDiff(c, f.path, paths);
			}
		} catch (e) {
			if (!current()) return;
			el.empty();
			el.createDiv({ cls: "light-git-hint", text: `오류: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
}
