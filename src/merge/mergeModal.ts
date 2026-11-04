import { App, Modal, Notice, setIcon } from "obsidian";
import type { ConflictVersions } from "../git/types";
import { ConfirmModal } from "../ui/confirmModal";
import { isBinary } from "../ui/diffModal";
import {
	acceptAll,
	apply,
	applyNonConflicting,
	buildRegions,
	changedSides,
	edit,
	ignore,
	isResolved,
	mergedText,
	regionResult,
	reset,
	type Region,
	type Side,
	unresolvedCount,
} from "./mergeModel";

const FOLD_OVER = 8;
const FOLD_KEEP = 3;

export interface MergeHost {
	/** 결과 저장: content가 null이면 파일 삭제 */
	saveResolution(path: string, content: string | null): Promise<void>;
}

/** IntelliJ처럼 변경 종류로 색을 구분: 수정(파랑) / 추가(초록) / 삭제(회색) / 충돌(빨강) */
function changeKind(r: Region, side: Side): string {
	if (r.kind === "conflict") return "conflict";
	if (!r.base.length) return "added";
	if (!r[side].length) return "deleted";
	return "modified";
}

/**
 * IntelliJ 스타일 3단 머지 화면.
 *   내 것(Local) | 결과 | 원격(Remote)
 * 변경 영역마다 » / « (적용), × (무시), 가운데 결과는 직접 편집 가능.
 * 좁은 화면(iOS)에서는 영역별 카드로 세로 배치된다.
 */
export class MergeModal extends Modal {
	private regions: Region[] = [];
	private gridEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private expanded = new Set<number>();

	constructor(
		app: App,
		private host: MergeHost,
		private path: string,
		private versions: ConflictVersions,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("light-git-merge-modal");
		this.contentEl.addClass("light-git-merge-body");
		this.setTitle(`충돌 해결 — ${this.path}`);
		const { ours, theirs, base } = this.versions;
		if (ours === null || theirs === null || isBinary(ours) || isBinary(theirs)) {
			this.renderWholeFileChoice();
			return;
		}
		this.regions = buildRegions(base ?? "", ours, theirs);
		this.renderToolbar();
		const header = this.contentEl.createDiv({ cls: "light-git-merge-header" });
		header.createDiv({ text: "내 것 (Local)" });
		header.createDiv({ text: "결과" });
		header.createDiv({ text: "원격 (Remote)" });
		this.gridEl = this.contentEl.createDiv({ cls: "light-git-merge-grid" });
		this.renderFooter();
		this.renderGrid();
	}

	onClose() {
		this.contentEl.empty();
	}

	/** 취소 버튼·Esc·바깥 탭 모두 여기로 온다. 처리한 내용이 있으면 버릴지 먼저 묻는다 */
	close() {
		if (!this.regions.some((r) => r.handled.length || r.edited !== null)) return super.close();
		new ConfirmModal(this.app, "처리한 내용이 저장되지 않습니다. 닫을까요?", "버리고 닫기", () => super.close()).open();
	}

	/** 한쪽이 삭제했거나 바이너리인 경우: 파일 단위로 고른다 */
	private renderWholeFileChoice() {
		const { ours, theirs } = this.versions;
		const box = this.contentEl.createDiv({ cls: "light-git-merge-choice" });
		const describe = (v: string | null) => (v === null ? "삭제함" : isBinary(v) ? "바이너리 파일" : `${v.split("\n").length}줄`);
		box.createEl("p", { text: `내 것: ${describe(ours)} · 원격: ${describe(theirs)}` });
		box.createEl("p", { cls: "setting-item-description", text: "줄 단위 병합이 불가능해서 파일 전체를 한쪽으로 선택합니다." });
		const row = box.createDiv({ cls: "light-git-merge-choice-buttons" });
		const choose = (label: string, content: string | null) => {
			const btn = row.createEl("button", { text: label });
			btn.onclick = () => this.save(content);
		};
		choose(ours === null ? "내 것 사용 (삭제)" : "내 것 사용", ours);
		choose(theirs === null ? "원격 사용 (삭제)" : "원격 사용", theirs);
	}

	private renderToolbar() {
		const bar = this.contentEl.createDiv({ cls: "light-git-merge-toolbar" });
		const btn = (icon: string, text: string, onClick: () => void) => {
			const b = bar.createEl("button", { cls: "light-git-tool-btn" });
			setIcon(b.createSpan({ cls: "light-git-tool-icon" }), icon);
			b.createSpan({ text });
			b.onclick = onClick;
		};
		btn("wand", "충돌 없는 변경 모두 적용", () => this.mutate(() => applyNonConflicting(this.regions)));
		bar.createDiv({ cls: "light-git-toolbar-sep" });
		btn("chevrons-right", "모두 내 것", () => this.mutate(() => acceptAll(this.regions, "ours")));
		btn("chevrons-left", "모두 원격", () => this.mutate(() => acceptAll(this.regions, "theirs")));
		bar.createDiv({ cls: "light-git-toolbar-sep" });
		btn("rotate-ccw", "초기화", () => this.mutate(() => this.regions.forEach(reset)));
	}

	private renderFooter() {
		const foot = this.contentEl.createDiv({ cls: "light-git-merge-footer" });
		this.summaryEl = foot.createDiv({ cls: "light-git-merge-summary" });
		const cancel = foot.createEl("button", { text: "취소" });
		cancel.onclick = () => this.close();
		this.saveBtn = foot.createEl("button", { text: "저장하고 해결", cls: "mod-cta" });
		this.saveBtn.onclick = () => this.trySave();
	}

	private mutate(fn: () => void) {
		fn();
		this.renderGrid();
	}

	private updateSummary() {
		const { conflicts, changes } = unresolvedCount(this.regions);
		const done = conflicts + changes === 0;
		this.summaryEl.empty();
		if (done) this.summaryEl.setText("모든 변경을 처리했습니다");
		else {
			if (conflicts) this.summaryEl.createSpan({ cls: "light-git-pill is-conflict", text: `충돌 ${conflicts}` });
			if (changes) this.summaryEl.createSpan({ cls: "light-git-pill", text: `변경 ${changes}` });
			this.summaryEl.createSpan({ text: "남음" });
		}
		this.summaryEl.toggleClass("is-done", done);
		this.saveBtn.toggleClass("is-disabled", !done);
	}

	private renderGrid() {
		const scrollTop = this.gridEl.scrollTop;
		this.gridEl.empty();
		// 줄 번호: 영역마다 각 칸의 시작 줄
		const n = { ours: 1, result: 1, theirs: 1 };
		this.regions.forEach((r, i) => {
			if (r.kind === "stable") this.renderStable(r, i, n);
			else this.renderChange(r, n);
			n.ours += r.ours.length;
			n.theirs += r.theirs.length;
			n.result += regionResult(r).length;
		});
		this.updateSummary();
		this.gridEl.scrollTop = scrollTop;
	}

	/** 줄 번호 + 코드 줄들. start가 null이면 번호 없음 */
	private lines(parent: HTMLElement, lines: string[], start: number | null, cls = "") {
		const box = parent.createDiv({ cls: `light-git-merge-lines ${cls}` });
		if (!lines.length) box.createDiv({ cls: "light-git-merge-line is-empty" });
		lines.forEach((l, k) => {
			const row = box.createDiv({ cls: "light-git-merge-line" });
			row.createSpan({ cls: "light-git-merge-ln", text: start === null ? "" : String(start + k) });
			row.createSpan({ cls: "light-git-merge-code", text: l || " " });
		});
		return box;
	}

	private renderStable(r: Region, i: number, n: { ours: number; result: number; theirs: number }) {
		const row = this.gridEl.createDiv({ cls: "light-git-merge-row is-stable" });
		const fold = r.base.length > FOLD_OVER && !this.expanded.has(i);
		const head = i === 0 ? 0 : FOLD_KEEP;
		for (const col of ["ours", "result", "theirs"] as const) {
			const cell = row.createDiv({ cls: `light-git-merge-cell col-${col}` });
			if (!fold) {
				this.lines(cell, r.base, n[col]);
				continue;
			}
			this.lines(cell, r.base.slice(0, head), n[col]);
			const f = cell.createDiv({ cls: "light-git-merge-fold", text: `${r.base.length - head - FOLD_KEEP}줄 동일` });
			f.onclick = () => {
				this.expanded.add(i);
				this.renderGrid();
			};
			this.lines(cell, r.base.slice(r.base.length - FOLD_KEEP), n[col] + r.base.length - FOLD_KEEP);
		}
	}

	private renderChange(r: Region, n: { ours: number; result: number; theirs: number }) {
		const resolved = isResolved(r);
		const row = this.gridEl.createDiv({ cls: `light-git-merge-row kind-${r.kind} ${resolved ? "is-resolved" : "is-pending"}` });
		const sides = changedSides(r);

		// 셀 = [줄들 | 거터(버튼)] — 원격 칸은 CSS로 좌우 반전해 거터가 결과 쪽에 오게 한다
		const sideCell = (side: Side) => {
			const changed = sides.includes(side);
			const kind = changed ? changeKind(r, side) : "none";
			const cell = row.createDiv({ cls: `light-git-merge-cell col-${side} change-${kind}` });
			cell.dataset.label = side === "ours" ? "내 것" : "원격";
			const body = cell.createDiv({ cls: "light-git-merge-side" });
			this.lines(body, r[side], n[side], changed ? "is-changed" : "is-same");
			const gutter = body.createDiv({ cls: "light-git-merge-gutter" });
			if (changed && !r.handled.includes(side)) {
				const applyBtn = gutter.createEl("button", { cls: "light-git-gutter-btn is-apply", attr: { "aria-label": "결과에 적용" } });
				setIcon(applyBtn, side === "ours" ? "chevrons-right" : "chevrons-left");
				applyBtn.onclick = () => this.mutate(() => apply(r, side));
				const ignoreBtn = gutter.createEl("button", { cls: "light-git-gutter-btn is-ignore", attr: { "aria-label": "무시" } });
				setIcon(ignoreBtn, "x");
				ignoreBtn.onclick = () => this.mutate(() => ignore(r, side));
			} else if (changed) {
				const done = r.applied.includes(side);
				const mark = gutter.createSpan({ cls: "light-git-merge-mark", attr: { "aria-label": done ? "적용됨" : "무시됨" } });
				setIcon(mark, done ? "check" : "minus");
			}
		};

		sideCell("ours");

		const mid = row.createDiv({ cls: `light-git-merge-cell col-result change-${resolved ? "none" : r.kind === "conflict" ? "conflict" : "modified"}` });
		mid.dataset.label = r.kind === "same" ? "결과 (양쪽 동일 변경)" : "결과";
		const midBody = mid.createDiv({ cls: "light-git-merge-side" });
		const ta = midBody.createEl("textarea", { cls: "light-git-merge-result", attr: { placeholder: "(빈 영역)", spellcheck: "false" } });
		const current = regionResult(r);
		ta.value = current.join("\n");
		ta.rows = Math.max(1, current.length);
		ta.addEventListener("input", () => {
			edit(r, ta.value === "" ? [] : ta.value.split("\n"));
			ta.rows = Math.max(1, ta.value.split("\n").length);
			row.removeClass("is-pending");
			row.addClass("is-resolved");
			this.updateSummary();
		});
		if (r.handled.length || r.edited) {
			const undo = midBody.createEl("button", { cls: "light-git-gutter-btn light-git-merge-reset", attr: { "aria-label": "이 영역 되돌리기" } });
			setIcon(undo, "rotate-ccw");
			undo.onclick = () => this.mutate(() => reset(r));
		}

		sideCell("theirs");
	}

	private trySave() {
		const { conflicts, changes } = unresolvedCount(this.regions);
		if (conflicts + changes > 0) {
			new Notice(`아직 처리하지 않은 영역이 있습니다 (충돌 ${conflicts}, 변경 ${changes}). ×로 무시하거나 적용하세요.`);
			return;
		}
		this.save(mergedText(this.regions));
	}

	private async save(content: string | null) {
		try {
			await this.host.saveResolution(this.path, content);
			super.close();
		} catch (e) {
			new Notice(`저장 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
}
