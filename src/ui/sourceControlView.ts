import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type { WorkChange } from "../git/types";
import type LightGitPlugin from "../main";
import { ConfirmModal } from "./confirmModal";
import { addPinButton } from "./pinButton";

export const SOURCE_CONTROL_VIEW = "light-git-source-control";

/**
 * IntelliJ Commit 창 스타일:
 *   [도구 아이콘]
 *   ▾ 충돌 / ▾ 변경 (체크박스 = 이 파일만 커밋)
 *   ─ 커밋 메시지 + 버튼 (아래 고정)
 * 체크한 파일이 없으면 전체를 커밋한다.
 */
export class SourceControlView extends ItemView {
	private messageEl!: HTMLTextAreaElement;
	private listEl!: HTMLElement;
	private commitBtn!: HTMLButtonElement;
	private hintEl!: HTMLElement;
	private loading = false;
	/** 읽는 도중 들어온 새로고침 요청 → 끝나고 한 번 더 */
	private again = false;
	/** 마지막으로 읽은 상태. 체크박스는 다시 읽지 않고 이걸 바꿔서 바로 그린다 */
	private state: { merging: boolean; conflicts: string[]; changes: WorkChange[] } | null = null;
	/** 숨겨져 있어서 갱신을 미룬 상태 */
	private stale = false;
	/** 체크(스테이징)된 파일이 있으면 그것만 커밋 */
	private stagedOnly = false;
	private collapsed = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: LightGitPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return SOURCE_CONTROL_VIEW;
	}

	getDisplayText() {
		return "Git";
	}

	getIcon() {
		return "git-branch";
	}

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("light-git-view");

		const bar = root.createDiv({ cls: "light-git-toolbar" });
		bar.createDiv({ cls: "light-git-toolbar-title", text: "변경 사항" });
		const tool = (icon: string, label: string, onClick: () => void) => {
			const b = bar.createDiv({ cls: "clickable-icon light-git-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = onClick;
		};
		tool("refresh-cw", "새로고침", () => this.refresh());
		tool("arrow-down-to-line", "Pull", () => this.plugin.pullCommand());
		tool("arrow-up-from-line", "Push", () => this.plugin.pushCommand());
		tool("history", "History", () => this.plugin.activateHistory());
		addPinButton(this, bar);

		this.listEl = root.createDiv({ cls: "light-git-list" });

		const commitBox = root.createDiv({ cls: "light-git-commit-box" });
		this.messageEl = commitBox.createEl("textarea", { cls: "light-git-message", attr: { rows: "3", spellcheck: "false" } });
		this.messageEl.addEventListener("keydown", (e) => {
			// Ctrl/Cmd+Enter로 커밋 (한글 조합 중 Enter는 무시)
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
				e.preventDefault();
				this.commit();
			}
		});
		const actions = commitBox.createDiv({ cls: "light-git-commit-actions" });
		this.hintEl = actions.createDiv({ cls: "light-git-commit-hint" });
		this.commitBtn = actions.createEl("button", { cls: "mod-cta light-git-commit-btn", text: "커밋 & 동기화" });
		this.commitBtn.onclick = () => this.commit();

		// 숨겨진 동안 미룬 갱신은 다시 보일 때 한다
		this.registerEvent(this.app.workspace.on("layout-change", () => this.stale && this.refresh()));
		await this.refresh();
	}

	onResize() {
		if (this.stale) this.refresh();
	}

	private async commit() {
		const msg = this.messageEl.value.trim();
		const ok = await this.plugin.sync(msg || undefined, false, this.stagedOnly);
		if (ok) this.messageEl.value = "";
	}

	async refresh() {
		if (this.plugin.isBusy() || !this.listEl) return;
		if (this.loading) {
			this.again = true;
			return;
		}
		// 사이드바가 닫혀 있으면 상태 확인(vault 전체 스캔)을 하지 않는다 — 모바일에선 타이핑 멈출 때마다 돌던 비용
		if (!this.contentEl.isShown()) {
			this.stale = true;
			return;
		}
		this.stale = false;
		this.loading = true;
		try {
			const b = await this.plugin.getBackend();
			if (!(await b.isRepo())) {
				this.renderNotConnected();
				return;
			}
			await this.plugin.stagingDone(); // 체크박스 처리 전 index를 읽으면 방금 누른 게 되돌아가 보인다
			const conflicts = await b.conflicts();
			const changes = (await b.changes()).filter((c) => !conflicts.includes(c.path));
			const merging = await b.isMerging();
			this.state = { merging, conflicts, changes };
			this.show();
		} catch (e) {
			this.listEl.empty();
			this.listEl.createDiv({ cls: "light-git-empty", text: `오류: ${e instanceof Error ? e.message : String(e)}` });
		} finally {
			this.loading = false;
		}
		if (this.again) {
			this.again = false;
			this.refresh();
		}
	}

	private show() {
		if (!this.state) return;
		const { merging, conflicts, changes } = this.state;
		const staged = changes.filter((c) => c.staged);
		this.stagedOnly = staged.length > 0 && !merging;
		const count = this.stagedOnly ? staged.length : changes.length + conflicts.length;
		this.messageEl.placeholder = `커밋 메시지 (비우면: ${this.plugin.defaultMessage(count)})`;
		this.commitBtn.setText(this.stagedOnly ? `${staged.length}개 커밋 & 동기화` : "커밋 & 동기화");
		this.hintEl.setText(merging ? "머지 커밋" : this.stagedOnly ? `${staged.length}/${changes.length} 선택` : changes.length ? `전체 ${changes.length}개` : "");
		this.render(merging, conflicts, changes);
	}

	/** 체크박스: 화면은 바로 바꾸고 스테이징은 뒤에서 순서대로 */
	private toggle(paths: string[], on: boolean) {
		if (this.plugin.isBusy()) {
			new Notice("Git 작업이 이미 진행 중입니다.");
			return this.show(); // 브라우저가 이미 바꾼 체크 표시를 되돌린다
		}
		for (const c of this.state?.changes ?? []) {
			if (!paths.includes(c.path)) continue;
			c.staged = on;
			c.unstaged = !on;
		}
		this.show();
		if (on) this.plugin.stage(paths);
		else this.plugin.unstage(paths);
	}

	private renderNotConnected() {
		this.listEl.empty();
		const box = this.listEl.createDiv({ cls: "light-git-empty" });
		box.createDiv({ text: "아직 Git 저장소가 연결되지 않았습니다." });
		const btn = box.createEl("button", { text: "원격 저장소 연결", cls: "mod-cta" });
		btn.onclick = () => this.plugin.connect();
	}

	private render(merging: boolean, conflicts: string[], changes: WorkChange[]) {
		this.listEl.empty();
		if (conflicts.length) {
			const g = this.group("conflicts", "충돌", conflicts.length, "is-conflict");
			for (const p of conflicts) this.row(g, p, "conflict", null, () => this.plugin.openMerge(p));
		}
		// 머지 중에는 변경 전체가 머지 커밋에 들어가므로 체크박스를 보여주지 않는다
		const staged = changes.filter((c) => c.staged);
		const g = this.group("changes", merging ? "머지됨" : "변경", changes.length, "", merging || !changes.length ? null : staged.length === changes.length ? "all" : staged.length ? "some" : "none", (on) => this.toggle(changes.map((c) => c.path), on));
		if (!changes.length && !merging) g.createDiv({ cls: "light-git-empty", text: "변경 사항 없음" });
		for (const c of changes) {
			const check = merging ? null : c.staged && c.unstaged ? "some" : c.staged ? "all" : "none";
			this.row(g, c.path, c.type, check, () => this.plugin.openChangeDiff(c.path));
		}
	}

	/** 접을 수 있는 그룹 헤더. check가 있으면 '전체 선택' 체크박스 */
	private group(id: string, title: string, count: number, cls: string, check: "all" | "some" | "none" | null = null, onCheck?: (on: boolean) => void) {
		const sec = this.listEl.createDiv({ cls: `light-git-group ${cls}` });
		const head = sec.createDiv({ cls: "light-git-group-head" });
		const chevron = head.createSpan({ cls: "light-git-chevron" });
		setIcon(chevron, this.collapsed.has(id) ? "chevron-right" : "chevron-down");
		if (check) this.checkbox(head, check, (on) => onCheck?.(on));
		head.createSpan({ cls: "light-git-group-title", text: title });
		head.createSpan({ cls: "light-git-group-count", text: String(count) });
		head.onclick = () => {
			if (this.collapsed.has(id)) this.collapsed.delete(id);
			else this.collapsed.add(id);
			sec.toggleClass("is-collapsed", this.collapsed.has(id));
			setIcon(chevron, this.collapsed.has(id) ? "chevron-right" : "chevron-down");
		};
		sec.toggleClass("is-collapsed", this.collapsed.has(id));
		return sec.createDiv({ cls: "light-git-group-body" });
	}

	private checkbox(parent: HTMLElement, state: "all" | "some" | "none", onChange: (on: boolean) => void) {
		const cb = parent.createEl("input", { type: "checkbox", cls: "light-git-check" });
		cb.checked = state === "all";
		cb.indeterminate = state === "some";
		cb.onclick = (e) => {
			e.stopPropagation();
			// 일부만 선택된 상태에서 누르면 전체 선택
			onChange(state !== "all");
		};
		return cb;
	}

	private row(parent: HTMLElement, path: string, type: string, check: "all" | "some" | "none" | null, onClick: () => void) {
		const row = parent.createDiv({ cls: `light-git-file type-${type}`, attr: { "aria-label": path } });
		if (check) this.checkbox(row, check, (on) => this.toggle([path], on));
		const slash = path.lastIndexOf("/");
		const name = row.createDiv({ cls: "light-git-file-name" });
		name.createSpan({ cls: "light-git-file-base", text: path.slice(slash + 1) });
		if (slash > 0) name.createSpan({ cls: "light-git-file-dir", text: path.slice(0, slash) });
		row.onclick = onClick;

		const actions = row.createDiv({ cls: "light-git-file-actions" });
		const action = (icon: string, label: string, run: () => void) => {
			const b = actions.createDiv({ cls: "clickable-icon light-git-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = (e) => {
				e.stopPropagation();
				run();
			};
		};
		if (type !== "deleted") action("file-text", "파일 열기", () => this.plugin.openFile(path));
		if (check) {
			// 머지 중(체크박스 없음)에는 되돌리기도 막는다
			action("undo-2", "변경 버리기", () => {
				const what = type === "added" ? "새 파일을 삭제" : "마지막 커밋 상태로 되돌리기";
				new ConfirmModal(this.app, `${path}\n변경을 버립니다 (${what}). 되돌릴 수 없습니다.`, "버리기", () => this.plugin.discard(path)).open();
			});
		}
	}
}
