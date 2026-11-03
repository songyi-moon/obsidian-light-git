import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import type { CommitInfo } from "../git/types";
import type LightGitPlugin from "../main";
import { addPinButton } from "./pinButton";

export const HISTORY_VIEW = "light-git-history";
const PAGE = 50;

function relativeTime(sec: number): string {
	const diff = Date.now() / 1000 - sec;
	if (diff < 60) return "방금";
	if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
	if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}일 전`;
	const d = new Date(sec * 1000);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class HistoryView extends ItemView {
	private listEl!: HTMLElement;
	private limit = PAGE;

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
		this.contentEl.empty();
		this.contentEl.addClass("light-git-view");
		const bar = this.contentEl.createDiv({ cls: "light-git-toolbar" });
		bar.createDiv({ cls: "light-git-toolbar-title", text: "History" });
		const refresh = bar.createDiv({ cls: "clickable-icon light-git-icon", attr: { "aria-label": "새로고침" } });
		setIcon(refresh, "refresh-cw");
		refresh.onclick = () => this.refresh();
		addPinButton(this, bar);
		this.listEl = this.contentEl.createDiv({ cls: "light-git-list" });
		await this.refresh();
	}

	async refresh() {
		if (!this.listEl || this.plugin.isBusy()) return;
		try {
			const b = await this.plugin.getBackend();
			const commits = (await b.isRepo()) ? await b.log(this.limit) : [];
			this.render(commits);
		} catch (e) {
			this.listEl.empty();
			this.listEl.createDiv({ cls: "light-git-empty", text: `오류: ${e instanceof Error ? e.message : String(e)}` });
		}
	}

	private render(commits: CommitInfo[]) {
		this.listEl.empty();
		if (!commits.length) {
			this.listEl.createDiv({ cls: "light-git-empty", text: "커밋이 없습니다." });
			return;
		}
		for (const c of commits) {
			const item = this.listEl.createDiv({ cls: "light-git-commit" });
			const head = item.createDiv({ cls: "light-git-commit-head" });
			head.createDiv({ cls: "light-git-commit-msg", text: c.message.split("\n")[0] });
			head.createDiv({ cls: "light-git-commit-meta", text: `${c.author} · ${relativeTime(c.timestamp)} · ${c.oid.slice(0, 7)}` });
			const files = item.createDiv({ cls: "light-git-commit-files" });
			files.hide();
			head.onclick = async () => {
				if (files.isShown()) return void files.hide();
				files.show();
				if (!files.childElementCount) await this.loadFiles(c, files);
			};
		}
		if (commits.length >= this.limit) {
			const more = this.listEl.createEl("button", { cls: "light-git-more", text: "더 보기" });
			more.onclick = () => {
				this.limit += PAGE;
				this.refresh();
			};
		}
	}

	private async loadFiles(c: CommitInfo, el: HTMLElement) {
		el.createDiv({ cls: "light-git-hint", text: "불러오는 중…" });
		try {
			const b = await this.plugin.getBackend();
			const files = await b.commitFiles(c.oid);
			el.empty();
			if (!files.length) el.createDiv({ cls: "light-git-hint", text: "변경 파일 없음" });
			for (const f of files) {
				// 변경 사항 뷰와 같은 모양: 상태는 파일명 색, 폴더는 흐리게
				const row = el.createDiv({ cls: `light-git-file type-${f.type}`, attr: { "aria-label": f.path } });
				const slash = f.path.lastIndexOf("/");
				const name = row.createDiv({ cls: "light-git-file-name" });
				name.createSpan({ cls: "light-git-file-base", text: f.path.slice(slash + 1) });
				if (slash > 0) name.createSpan({ cls: "light-git-file-dir", text: f.path.slice(0, slash) });
				row.onclick = () => this.plugin.openCommitDiff(c, f.path);
			}
		} catch (e) {
			el.empty();
			el.createDiv({ cls: "light-git-hint", text: `오류: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
}
