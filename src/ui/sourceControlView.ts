import { ItemView, Menu, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import { isNewConflictCopy, type WorkChange } from "../git/types";
import type LightGitPlugin from "../main";
import { asButton, revealInList } from "./asButton";
import { ConfirmModal } from "./confirmModal";
import { addPinButton } from "./pinButton";

export const SOURCE_CONTROL_VIEW = "light-git-source-control";
/** 변경 파일이 이만큼 많으면 검색칸을 보여 주고 폴더별로 묶는다 */
const MANY_FILES = 15;

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
	private filterEl!: HTMLInputElement;
	private commitBtn!: HTMLButtonElement;
	private hintEl!: HTMLElement;
	private loading = false;
	/** 읽는 도중 들어온 새로고침 요청 → 끝나고 한 번 더 */
	private again = false;
	/** 마지막으로 읽은 상태. 체크박스는 다시 읽지 않고 이걸 바꿔서 바로 그린다 */
	private state: { merging: boolean; conflicts: string[]; changes: WorkChange[]; copies: string[]; unpushed: number } | null = null;
	private statusEl!: HTMLElement;
	/** 숨겨져 있어서 갱신을 미룬 상태 */
	private stale = false;
	/** 체크(스테이징)된 파일이 있으면 그것만 커밋 */
	private stagedOnly = false;
	private collapsed = new Set<string>();
	private commitOnlyBtn!: HTMLButtonElement;
	/** 키보드로 고른 행 (다시 그려도 유지) */
	private selected: string | null = null;
	/** 폴더별 묶기. 고르기 전에는 파일이 많을 때만 묶는다 */
	private groupByDir: boolean | null = null;
	private groupBtn!: HTMLElement;

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
		const branch = bar.createDiv({ cls: "light-git-branch", attr: { "aria-label": "현재 브랜치" } });
		setIcon(branch.createSpan({ cls: "light-git-branch-icon" }), "git-branch");
		branch.createSpan({ text: this.plugin.settings.branch || "main" });
		const tool = (icon: string, label: string, onClick: () => void, cls = "light-git-busy-off") => {
			const b = bar.createDiv({ cls: `clickable-icon light-git-icon ${cls}`, attr: { "aria-label": label } });
			setIcon(b, icon);
			asButton(b, onClick);
			return b;
		};
		tool("refresh-cw", "새로고침", () => this.refresh());
		// arrow-down-to-line 등은 Obsidian 1.4.x에 없어 빈칸이 된다. 오래된 버전에도 있는 아이콘만 쓴다
		tool("arrow-down", "Pull", () => this.plugin.pullCommand());
		tool("arrow-up", "Push", () => this.plugin.pushCommand());
		tool("history", "History", () => this.plugin.activateHistory(), "");
		this.groupBtn = tool(
			"folder-tree",
			"폴더별로 묶기",
			() => {
				this.groupByDir = !this.isGrouped();
				this.show();
			},
			"",
		);
		addPinButton(this, bar);

		this.statusEl = root.createDiv({ cls: "light-git-status" });
		this.filterEl = root.createEl("input", { type: "search", cls: "light-git-filter is-hidden", attr: { placeholder: "변경 파일 검색", "aria-label": "변경 파일 검색" } });
		this.filterEl.addEventListener("input", () => this.show());
		this.listEl = root.createDiv({ cls: "light-git-list", attr: { tabindex: "0", role: "tree", "aria-label": "변경 파일" } });
		this.registerDomEvent(this.listEl, "keydown", (e) => this.onKey(e));

		const commitBox = root.createDiv({ cls: "light-git-commit-box" });
		this.messageEl = commitBox.createEl("textarea", { cls: "light-git-message", attr: { rows: "3", spellcheck: "false", placeholder: "커밋 메시지", "aria-label": "커밋 메시지" } });
		this.messageEl.addEventListener("keydown", (e) => {
			// Ctrl/Cmd+Enter로 커밋 (한글 조합 중 Enter는 무시)
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
				e.preventDefault();
				this.commit();
			}
		});
		const actions = commitBox.createDiv({ cls: "light-git-commit-actions" });
		this.hintEl = actions.createDiv({ cls: "light-git-commit-hint" });
		this.commitOnlyBtn = actions.createEl("button", { cls: "light-git-commit-only", text: "커밋", attr: { "aria-label": "커밋만 하고 올리지 않음" } });
		this.commitOnlyBtn.onclick = () => this.commitOnly();
		this.commitBtn = actions.createEl("button", { cls: "mod-cta light-git-commit-btn", text: "커밋 & 동기화", attr: { "aria-label": "커밋 & 동기화 (Ctrl+Enter)" } });
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

	private async commitOnly() {
		const msg = this.messageEl.value.trim();
		const ok = await this.plugin.commitOnly(msg || undefined, this.stagedOnly);
		if (ok) this.messageEl.value = "";
	}

	private isGrouped() {
		return this.groupByDir ?? (this.state?.changes.length ?? 0) >= MANY_FILES;
	}

	/** 지금 보이는 행 (접힌 그룹 안은 제외) */
	private keyRows(): HTMLElement[] {
		return Array.from(this.listEl.querySelectorAll<HTMLElement>(".light-git-group-head, .light-git-file")).filter((r) => r.offsetParent !== null);
	}

	private select(row: HTMLElement) {
		this.selected = row.dataset.key ?? null;
		this.markSelected();
		revealInList(this.listEl, row);
	}

	private markSelected() {
		for (const r of Array.from(this.listEl.querySelectorAll<HTMLElement>("[data-key]"))) {
			const on = r.dataset.key === this.selected;
			r.toggleClass("is-selected", on);
			r.setAttribute("aria-selected", String(on));
		}
	}

	/** IntelliJ 변경 목록 키. 문자 키는 한글 입력 상태에서도 동작하도록 e.code로 비교한다 */
	private onKey(e: KeyboardEvent) {
		if (e.target !== this.listEl) return;
		const rows = this.keyRows();
		const cur = rows.findIndex((r) => r.dataset.key === this.selected);
		const row = rows[cur] as HTMLElement | undefined;
		const isHead = !!row?.classList.contains("light-git-group-head");
		const collapsed = !!row?.parentElement?.classList.contains("is-collapsed");
		const mod = e.ctrlKey || e.metaKey;
		const action = (label: string) => row?.querySelector<HTMLElement>(`.light-git-file-actions [aria-label="${label}"]`)?.click();
		if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
			const next = e.key === "ArrowDown" ? Math.min(cur + 1, rows.length - 1) : e.key === "ArrowUp" ? Math.max(cur - 1, 0) : e.key === "Home" ? 0 : rows.length - 1;
			if (rows[next]) this.select(rows[next]);
		} else if (!row) return;
		else if (e.key === " ") row.querySelector<HTMLInputElement>("input")?.click();
		else if (e.key === "Enter" || (mod && e.code === "KeyD")) row.click();
		else if (e.key === "ArrowRight" && isHead && collapsed) row.click();
		else if (e.key === "ArrowLeft" && isHead && !collapsed) row.click();
		else if (e.key === "ArrowLeft" && !isHead) {
			const head = row.closest(".light-git-group")?.querySelector<HTMLElement>(".light-git-group-head");
			if (head) this.select(head);
		} else if (e.key === "F4") action("파일 열기");
		else if (mod && e.altKey && e.code === "KeyZ") {
			if (isHead) row.querySelector<HTMLElement>(".light-git-head-action")?.click();
			else action("변경 버리기");
		}
		else return;
		e.preventDefault();
		e.stopPropagation();
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
				this.state = null;
				this.renderStatus();
				this.renderNotConnected();
				return;
			}
			await this.plugin.stagingDone(); // 체크박스 처리 전 index를 읽으면 방금 누른 게 되돌아가 보인다
			const conflicts = await b.conflicts();
			const all = (await b.changes()).filter((c) => !conflicts.includes(c.path));
			const changes = all.filter((c) => !isNewConflictCopy(c));
			const copies = all.filter(isNewConflictCopy).map((c) => c.path);
			const merging = await b.isMerging();
			this.state = { merging, conflicts, changes, copies, unpushed: await b.unpushedCount() };
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
		const { merging, conflicts, changes, copies } = this.state;
		const staged = changes.filter((c) => c.staged);
		this.stagedOnly = staged.length > 0 && !merging;
		const count = this.stagedOnly ? staged.length : changes.length + conflicts.length;
		this.messageEl.placeholder = count || merging ? "커밋 메시지 (비우면 자동 작성)" : "커밋할 변경 없음";
		this.commitBtn.setText(merging && !conflicts.length ? "머지 완료 & 동기화" : this.stagedOnly ? `${staged.length}개 커밋 & 동기화` : count ? "커밋 & 동기화" : "동기화");
		this.hintEl.setText(conflicts.length ? `충돌 ${conflicts.length}건 남음` : merging ? "머지 커밋" : this.stagedOnly ? `${staged.length}/${changes.length} 선택` : changes.length ? `전체 ${changes.length}개` : "");
		this.render(merging, conflicts, changes, copies);
		this.renderStatus();
	}

	/** 상단 상태 줄: 진행 중인 작업, 또는 올리지 않은 커밋과 마지막 작업 결과 */
	renderStatus() {
		if (!this.statusEl) return;
		const running = this.plugin.runningLabel();
		const last = this.plugin.lastRun;
		const unpushed = this.state?.unpushed ?? 0;
		this.contentEl.toggleClass("is-busy", !!running);
		this.commitBtn.disabled = !!running || !!this.state?.conflicts.length;
		this.commitOnlyBtn.disabled = this.commitBtn.disabled || !(this.state?.merging || this.state?.changes.length);
		this.statusEl.empty();
		this.statusEl.toggleClass("is-empty", !running && !last && !unpushed);
		if (running) {
			this.statusEl.createSpan({ cls: "light-git-spinner" });
			this.statusEl.createSpan({ text: `${running} 중…` });
			return;
		}
		if (unpushed) this.statusEl.createSpan({ cls: "light-git-status-unpushed", text: `↑ ${unpushed}개 push 대기` });
		if (last) this.statusEl.createSpan({ cls: `light-git-status-last${last.failed ? " is-failed" : ""}`, text: last.text });
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
		if (!this.plugin.settings.remoteUrl) {
			box.createDiv({ text: "설정에서 저장소 URL과 토큰을 입력하세요." });
			const open = box.createEl("button", { text: "설정 열기", cls: "mod-cta" });
			open.onclick = () => this.plugin.openSettings();
			return;
		}
		const btn = box.createEl("button", { text: "원격 저장소 연결", cls: "mod-cta" });
		btn.onclick = () => this.plugin.connect();
	}

	private render(merging: boolean, conflicts: string[], changes: WorkChange[], copies: string[]) {
		const scrollTop = this.listEl.scrollTop; // 체크박스를 누를 때마다 다시 그리므로 위치를 지킨다
		this.listEl.empty();
		const grouped = this.isGrouped();
		this.groupBtn.toggleClass("is-active", grouped);
		this.groupBtn.setAttribute("aria-pressed", String(grouped));
		if (conflicts.length) {
			const g = this.group("conflicts", "충돌", conflicts.length, "is-conflict");
			for (const p of conflicts) this.row(g, p, "conflict", null, () => this.plugin.openMerge(p));
		}
		// 검색은 보기만 줄인다. 커밋 대상은 그대로이고, 충돌은 처리해야 하므로 숨기지 않는다
		const query = this.filterEl.value.trim().toLowerCase();
		this.filterEl.toggleClass("is-hidden", !query && changes.length < MANY_FILES);
		const shown = query ? changes.filter((c) => c.path.toLowerCase().includes(query)) : changes;
		// 머지 중에는 변경 전체가 머지 커밋에 들어가므로 체크박스를 보여주지 않는다
		const groupCheck = (files: WorkChange[]) => {
			const staged = files.filter((c) => c.staged);
			return merging || !files.length ? null : staged.length === files.length ? "all" : staged.length ? "some" : "none";
		};
		const g = this.group("changes", merging ? "머지됨" : "변경", query ? `${shown.length}/${changes.length}` : changes.length, "", groupCheck(shown), (on) => this.toggle(shown.map((c) => c.path), on));
		const picked = merging ? [] : shown.filter((c) => c.staged);
		if (picked.length) this.discardPickedButton(g, picked);
		if (!shown.length && query) g.createDiv({ cls: "light-git-empty", text: "검색 결과 없음" });
		else if (!changes.length && !merging) g.createDiv({ cls: "light-git-empty", text: "변경 사항 없음" });
		// Diff 창에서 F7로 파일 사이를 오가는 순서 = 화면 순서
		const diffOrder: string[] = [];
		const fileRows = (parent: HTMLElement, files: WorkChange[]) => {
			for (const c of files) {
				diffOrder.push(c.path);
				const check = merging ? null : c.staged && c.unstaged ? "some" : c.staged ? "all" : "none";
				this.row(parent, c.path, c.type, check, () => this.plugin.openChangeDiff(c.path, diffOrder));
			}
		};
		if (!grouped) fileRows(g, shown);
		else {
			const folders = new Map<string, WorkChange[]>();
			for (const c of shown) {
				const dir = c.path.slice(0, Math.max(c.path.lastIndexOf("/"), 0));
				folders.set(dir, [...(folders.get(dir) ?? []), c]);
			}
			for (const [dir, files] of [...folders].sort(([a], [b]) => a.localeCompare(b))) {
				fileRows(this.group(`dir:${dir}`, dir || "(최상위)", files.length, "is-folder", groupCheck(files), (on) => this.toggle(files.map((c) => c.path), on), g), files);
			}
		}
		if (copies.length) {
			const body = this.group("copies", "충돌 사본", copies.length, "");
			body.createDiv({ cls: "light-git-hint", text: "원격에 올라가지 않습니다. 원본과 비교해 필요한 내용을 옮긴 뒤 삭제하세요. 그대로 올리려면 파일 이름을 바꾸세요." });
			for (const p of copies) {
				this.row(body, p, "added", null, () => this.plugin.openCopyDiff(p), () => {
					new ConfirmModal(this.app, `${p}\n충돌 사본을 삭제합니다. 취소할 수 없습니다.`, "삭제", () => this.plugin.discard(p)).open();
				});
			}
		}
		this.markSelected();
		this.listEl.scrollTop = scrollTop;
	}

	/** 체크한 파일의 변경을 한 번에 버리는 머리글 버튼. 검색으로 가려진 파일은 건드리지 않는다 */
	private discardPickedButton(body: HTMLElement, picked: WorkChange[]) {
		const head = body.parentElement?.querySelector<HTMLElement>(".light-git-group-head");
		if (!head) return;
		const b = head.createDiv({ cls: "clickable-icon light-git-icon light-git-head-action light-git-busy-off", attr: { "aria-label": "선택한 변경 버리기" } });
		setIcon(b, "undo-2");
		b.onclick = (e) => {
			e.stopPropagation();
			const names = picked.slice(0, 5).map((c) => c.path).join("\n") + (picked.length > 5 ? `\n외 ${picked.length - 5}개` : "");
			const added = picked.filter((c) => c.type === "added").length;
			const text = `선택한 ${picked.length}개 파일을 마지막 커밋 상태로 되돌립니다.${added ? ` 새 파일 ${added}개는 삭제됩니다.` : ""} 취소할 수 없습니다.\n\n${names}`;
			new ConfirmModal(this.app, text, "버리기", () => this.plugin.discardAll(picked.map((c) => c.path))).open();
		};
	}

	/** 접을 수 있는 그룹 헤더. check가 있으면 '전체 선택' 체크박스 */
	private group(id: string, title: string, count: number | string, cls: string, check: "all" | "some" | "none" | null = null, onCheck?: (on: boolean) => void, parent = this.listEl) {
		const sec = parent.createDiv({ cls: `light-git-group ${cls}` });
		const head = sec.createDiv({ cls: "light-git-group-head", attr: { "data-key": `g:${id}`, role: "treeitem" } });
		const chevron = head.createSpan({ cls: "light-git-chevron" });
		setIcon(chevron, this.collapsed.has(id) ? "chevron-right" : "chevron-down");
		if (check) this.checkbox(head, check, (on) => onCheck?.(on));
		head.createSpan({ cls: "light-git-group-title", text: title });
		head.createSpan({ cls: "light-git-group-count", text: String(count) });
		head.setAttribute("aria-expanded", String(!this.collapsed.has(id)));
		head.onclick = () => {
			if (this.collapsed.has(id)) this.collapsed.delete(id);
			else this.collapsed.add(id);
			sec.toggleClass("is-collapsed", this.collapsed.has(id));
			head.setAttribute("aria-expanded", String(!this.collapsed.has(id)));
			setIcon(chevron, this.collapsed.has(id) ? "chevron-right" : "chevron-down");
			this.select(head);
		};
		sec.toggleClass("is-collapsed", this.collapsed.has(id));
		return sec.createDiv({ cls: "light-git-group-body" });
	}

	private checkbox(parent: HTMLElement, state: "all" | "some" | "none", onChange: (on: boolean) => void) {
		// 라벨로 감싸 터치 영역을 넓힌다. 빗나간 탭이 행(diff 열기)이나 머리글(접기)로 가지 않게 막는다
		const wrap = parent.createEl("label", { cls: "light-git-check-wrap" });
		wrap.onclick = (e) => e.stopPropagation();
		const cb = wrap.createEl("input", { type: "checkbox", cls: "light-git-check" });
		cb.tabIndex = -1; // 목록에서 Space로 누른다. 행마다 Tab이 멈추지 않게
		cb.checked = state === "all";
		cb.indeterminate = state === "some";
		cb.onclick = (e) => {
			e.stopPropagation();
			// 일부만 선택된 상태에서 누르면 전체 선택
			onChange(state !== "all");
		};
		return cb;
	}

	private row(parent: HTMLElement, path: string, type: string, check: "all" | "some" | "none" | null, onClick: () => void, onDeleteCopy?: () => void) {
		const row = parent.createDiv({ cls: `light-git-file type-${type}`, attr: { "aria-label": path, "data-key": `f:${path}`, role: "treeitem" } });
		if (check) this.checkbox(row, check, (on) => this.toggle([path], on));
		const slash = path.lastIndexOf("/");
		const name = row.createDiv({ cls: "light-git-file-name" });
		name.createSpan({ cls: "light-git-file-base", text: path.slice(slash + 1) });
		if (slash > 0) name.createSpan({ cls: "light-git-file-dir", text: path.slice(0, slash) });
		row.onclick = () => {
			this.select(row);
			onClick();
		};

		const actions = row.createDiv({ cls: "light-git-file-actions" });
		const menu: [string, string, () => void][] = [[type === "conflict" ? "git-merge" : "diff", type === "conflict" ? "충돌 해결" : "차이 보기", onClick]];
		const action = (icon: string, label: string, run: () => void) => {
			const b = actions.createDiv({ cls: "clickable-icon light-git-icon", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = (e) => {
				e.stopPropagation();
				run();
			};
			menu.push([icon, label, run]);
		};
		if (type !== "deleted") action("file-text", "파일 열기", () => this.plugin.openFile(path));
		if (onDeleteCopy) action("trash-2", "사본 삭제", onDeleteCopy);
		if (check) {
			// 머지 중(체크박스 없음)에는 되돌리기도 막는다
			action("undo-2", "변경 버리기", () => {
				const what = type === "added" ? "새 파일을 삭제합니다" : "마지막 커밋 상태로 돌아갑니다";
				new ConfirmModal(this.app, `${path}\n${what}. 취소할 수 없습니다.`, "버리기", () => this.plugin.discard(path)).open();
			});
		}
		row.oncontextmenu = (e) => {
			e.preventDefault();
			this.select(row);
			const m = new Menu();
			for (const [icon, label, run] of menu) m.addItem((item) => item.setTitle(label).setIcon(icon).onClick(run));
			m.showAtMouseEvent(e);
		};
	}
}
