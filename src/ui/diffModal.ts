import { App, Modal, Notice, setIcon } from "obsidian";
import { diffComm } from "node-diff3";
import { ConfirmModal } from "./confirmModal";

const CONTEXT = 3;

export function isBinary(text: string | null): boolean {
	return !!text && (text.includes("\u0000") || text.includes("�"));
}

type DiffMode = "side" | "unified";
/** 사용자가 고른 보기 방식 (앱을 다시 켜기 전까지 유지). 처음엔 화면 폭으로 정한다 — 머지 화면과 같은 900px 기준 */
let chosenMode: DiffMode | null = null;

/** o/n = 이 블록 첫 줄의 이전/이후 줄 번호 */
type Block =
	| { kind: "same"; lines: string[]; o: number; n: number }
	| { kind: "fold"; lines: string[]; o: number; n: number }
	| { kind: "change"; del: string[]; add: string[]; o: number; n: number };
type Change = Extract<Block, { kind: "change" }>;

/** Diff 창에 보여 줄 파일 하나 */
export interface DiffContent {
	title: string;
	oldText: string | null;
	newText: string | null;
	/** F4: 노트 열기 */
	openFile?: () => void;
	/** 있으면 변경 블록을 되돌릴 수 있다. expected와 지금 파일이 다르면 쓰지 않고 false */
	saveNew?: (expected: string, next: string) => Promise<boolean>;
}

/** 파일 사이를 오가는 목록 */
export interface DiffFiles {
	count: number;
	index: number;
	load: (index: number) => Promise<DiffContent>;
}

/** 줄 단위 diff를 블록으로. 긴 동일 구간은 앞뒤 CONTEXT줄만 남기고 접는다 */
function diffBlocks(a: string[], b: string[]): Block[] {
	const out: Block[] = [];
	let o = 1;
	let n = 1;
	const same = (lines: string[]) => {
		if (!lines.length) return;
		out.push({ kind: "same", lines, o, n });
		o += lines.length;
		n += lines.length;
	};
	const chunks = diffComm(a, b);
	chunks.forEach((c, idx) => {
		if (c.common) {
			const lines = c.common;
			const head = idx === 0 ? 0 : CONTEXT;
			const tail = idx === chunks.length - 1 ? 0 : CONTEXT;
			if (lines.length > head + tail + 1) {
				same(lines.slice(0, head));
				const hidden = lines.slice(head, lines.length - tail);
				out.push({ kind: "fold", lines: hidden, o, n });
				o += hidden.length;
				n += hidden.length;
				same(lines.slice(lines.length - tail));
			} else {
				same(lines);
			}
		} else {
			out.push({ kind: "change", del: c.buffer1, add: c.buffer2, o, n });
			o += c.buffer1.length;
			n += c.buffer2.length;
		}
	});
	return out;
}

/** 앞뒤가 같은 부분을 뺀 가운데 범위 [시작, 끝). 공통 부분이 없거나 내용이 같으면 null */
function changedRange(text: string, other: string): [number, number] | null {
	const max = Math.min(text.length, other.length);
	let head = 0;
	while (head < max && text[head] === other[head]) head++;
	let tail = 0;
	while (tail < max - head && text[text.length - 1 - tail] === other[other.length - 1 - tail]) tail++;
	// 이모지 같은 서로게이트 쌍을 가르지 않는다
	if (head > 0 && /[\uD800-\uDBFF]/.test(text[head - 1])) head--;
	if (tail > 0 && /[\uDC00-\uDFFF]/.test(text[text.length - tail])) tail--;
	const end = text.length - tail;
	return (head === 0 && tail === 0) || head >= end ? null : [head, end];
}

/**
 * IntelliJ Diff 창. 나란히(왼쪽 이전 | 오른쪽 이후) 또는 한 줄(unified) 보기.
 * F7 / Shift+F7로 변경 사이를, 끝에서 한 번 더 누르거나 Alt+←/→로 파일 사이를 오간다.
 */
export class DiffModal extends Modal {
	/** 변경 블록별 화면 행 */
	private hunks: HTMLElement[][] = [];
	private hunk = -1;
	/** 끝에 닿아 옆 파일로 넘어가려고 기다리는 방향 */
	private pending = 0;
	private mode: DiffMode = "side";
	private bodyEl: HTMLElement | null = null;
	private countEl: HTMLElement | null = null;
	private edgeEl: HTMLElement | null = null;
	private loading = 0;

	constructor(
		app: App,
		private content: DiffContent,
		private files?: DiffFiles,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("light-git-diff-modal");
		this.contentEl.addClass("light-git-diff-body");
		const key = (mods: ("Shift" | "Alt")[], name: string, run: () => void) => {
			this.scope.register(mods, name, () => {
				run();
				return false;
			});
		};
		key([], "F7", () => this.go(1));
		key(["Shift"], "F7", () => this.go(-1));
		key(["Alt"], "ArrowRight", () => this.moveFile(1));
		key(["Alt"], "ArrowLeft", () => this.moveFile(-1));
		key([], "F4", () => this.openFile());
		this.render(chosenMode ?? (window.innerWidth >= 900 ? "side" : "unified"), 0);
	}

	/** first: 처음 선택할 변경 (음수면 마지막부터) */
	private render(mode: DiffMode, first: number) {
		this.mode = mode;
		this.hunks = [];
		this.hunk = -1;
		this.pending = 0;
		this.bodyEl = null;
		this.contentEl.empty();
		this.modalEl.toggleClass("is-side", mode === "side");
		this.setTitle(this.content.title);
		const { oldText, newText } = this.content;
		this.renderBar(mode);
		if (isBinary(oldText) || isBinary(newText)) {
			this.contentEl.createDiv({ cls: "light-git-empty", text: "바이너리 파일은 비교할 수 없습니다." });
			return this.showCount();
		}

		const body = this.contentEl.createDiv({ cls: `light-git-diff is-${mode}` });
		this.bodyEl = body;
		const blocks = diffBlocks(oldText === null ? [] : oldText.split("\n"), newText === null ? [] : newText.split("\n"));
		if (!blocks.some((x) => x.kind === "change")) {
			body.createDiv({ cls: "light-git-empty", text: "변경 내용이 없습니다." });
			return this.showCount();
		}
		if (mode === "side") this.renderSide(body, blocks);
		else this.renderUnified(body, blocks);
		const n = this.hunks.length;
		this.select(Math.min(first < 0 ? n - 1 : first, n - 1));
	}

	private renderBar(mode: DiffMode) {
		const bar = this.contentEl.createDiv({ cls: "light-git-diff-bar" });
		const tools = bar.createDiv({ cls: "light-git-diff-tools" });
		const tool = (icon: string, label: string, run: () => void) => {
			const b = tools.createEl("button", { cls: "light-git-diff-tool", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = run;
		};
		tool("arrow-up", "이전 변경 (Shift+F7)", () => this.go(-1));
		tool("arrow-down", "다음 변경 (F7)", () => this.go(1));
		this.countEl = tools.createSpan({ cls: "light-git-diff-count" });
		if (this.files && this.files.count > 1) {
			tools.createDiv({ cls: "light-git-toolbar-sep" });
			tool("arrow-left", "이전 파일 (Alt+←)", () => this.moveFile(-1));
			tools.createSpan({ cls: "light-git-diff-count", text: `파일 ${this.files.index + 1} / ${this.files.count}` });
			tool("arrow-right", "다음 파일 (Alt+→)", () => this.moveFile(1));
		}
		if (this.content.openFile) {
			tools.createDiv({ cls: "light-git-toolbar-sep" });
			tool("file-text", "노트 열기 (F4)", () => this.openFile());
		}

		const modes = bar.createDiv({ cls: "light-git-diff-modes" });
		const items: [DiffMode, string][] = [
			["side", "나란히"],
			["unified", "한 줄"],
		];
		for (const [m, label] of items) {
			const btn = modes.createEl("button", { text: label });
			btn.toggleClass("is-active", m === mode);
			btn.onclick = () => {
				chosenMode = m;
				this.render(m, Math.max(this.hunk, 0));
			};
		}
		if (this.content.oldText === null) modes.createDiv({ cls: "light-git-diff-note", text: "새 파일" });
		if (this.content.newText === null) modes.createDiv({ cls: "light-git-diff-note", text: "삭제된 파일" });
		this.edgeEl = bar.createDiv({ cls: "light-git-diff-edge", attr: { role: "status", "aria-live": "polite" } });
	}

	private showCount() {
		this.countEl?.setText(this.hunks.length ? `${this.hunk + 1} / ${this.hunks.length}` : "변경 없음");
	}

	private select(index: number) {
		for (const row of this.hunks[this.hunk] ?? []) row.removeClass("is-current-hunk");
		this.hunk = index;
		this.pending = 0;
		this.edgeEl?.setText("");
		const rows = this.hunks[index] ?? [];
		for (const row of rows) row.addClass("is-current-hunk");
		this.showCount();
		const body = this.bodyEl;
		if (rows[0] && body) body.scrollTop += rows[0].getBoundingClientRect().top - body.getBoundingClientRect().top - 48; // 위쪽 문맥 몇 줄이 보이도록
	}

	/** 다음·이전 변경. 끝에서는 옆 파일이 있으면 한 번 더 눌러 넘어가고, 없으면 반대쪽 끝으로 돌아간다 */
	private go(dir: 1 | -1) {
		const next = this.hunk + dir;
		if (next >= 0 && next < this.hunks.length) return this.select(next);
		const neighbor = this.files ? this.files.index + dir : -1;
		if (this.files && neighbor >= 0 && neighbor < this.files.count) {
			if (this.pending === dir || !this.hunks.length) return void this.moveFile(dir);
			this.pending = dir;
			this.edgeEl?.setText(`${dir > 0 ? "마지막" : "첫"} 변경입니다. ${dir > 0 ? "F7" : "Shift+F7"}을 한 번 더 누르면 ${dir > 0 ? "다음" : "이전"} 파일로 갑니다.`);
			return;
		}
		if (this.hunks.length) this.select(dir > 0 ? 0 : this.hunks.length - 1);
	}

	private async moveFile(dir: 1 | -1) {
		const files = this.files;
		if (!files) return;
		const index = files.index + dir;
		if (index < 0 || index >= files.count) return;
		const token = ++this.loading;
		try {
			const content = await files.load(index);
			if (token !== this.loading) return;
			this.content = content;
			files.index = index;
			this.render(this.mode, dir > 0 ? 0 : -1);
		} catch (e) {
			new Notice(`diff 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private openFile() {
		const open = this.content.openFile;
		if (!open) return;
		this.close();
		open();
	}

	/** 이 블록을 이전 내용으로 되돌린다. 저장되면 다시 그린다 */
	private revert(blk: Change) {
		const { newText, saveNew } = this.content;
		if (newText === null || !saveNew) return;
		const lines = newText.split("\n");
		lines.splice(blk.n - 1, blk.add.length, ...blk.del);
		const next = lines.join("\n");
		new ConfirmModal(this.app, "이 부분을 마지막 커밋 내용으로 바꿉니다. 취소할 수 없습니다.", "되돌리기", () => {
			void saveNew(newText, next).then((saved) => {
				if (!saved) return;
				this.content = { ...this.content, newText: next };
				this.render(this.mode, this.hunk);
			});
		}).open();
	}

	private revertButton(parent: HTMLElement, blk: Change, icon: string) {
		if (!this.content.saveNew || this.content.oldText === null || this.content.newText === null) return;
		const b = parent.createEl("button", { cls: "light-git-diff-revert", attr: { "aria-label": "이 변경 되돌리기" } });
		setIcon(b, icon);
		b.onclick = (e) => {
			e.stopPropagation();
			this.revert(blk);
		};
	}

	/** 줄 내용을 채운다. other가 있으면 그 줄과 다른 부분만 강조 */
	private fillCode(el: HTMLElement, text: string, other: string | null) {
		const range = other === null ? null : changedRange(text, other);
		if (!range) return void el.setText(text || " ");
		const [start, end] = range;
		if (start) el.createSpan({ text: text.slice(0, start) });
		el.createSpan({ cls: "light-git-word", text: text.slice(start, end) });
		if (end < text.length) el.createSpan({ text: text.slice(end) });
	}

	/** 접힌 구간. 누르면 그 자리에서 펼친다 (전체를 다시 그리면 스크롤 위치를 잃는다) */
	private foldRow(body: HTMLElement, blk: Extract<Block, { kind: "fold" }>, draw: (parent: HTMLElement, blocks: Block[]) => void) {
		const fold = body.createDiv({ cls: "light-git-diff-fold", text: `${blk.lines.length}줄 동일` });
		fold.onclick = () => {
			const opened = body.createDiv();
			fold.replaceWith(opened);
			draw(opened, [{ ...blk, kind: "same" }]);
		};
	}

	private renderUnified(body: HTMLElement, blocks: Block[]) {
		const line = (cls: string, sign: string, text: string, other: string | null, o: number | "", n: number | "") => {
			const row = body.createDiv({ cls: `light-git-diff-line ${cls}` });
			row.createSpan({ cls: "light-git-ln", text: String(o) });
			row.createSpan({ cls: "light-git-ln", text: String(n) });
			row.createSpan({ cls: "light-git-sign", text: sign });
			this.fillCode(row.createSpan({ cls: "light-git-code" }), text, other);
			return row;
		};
		for (const blk of blocks) {
			if (blk.kind === "fold") this.foldRow(body, blk, (p, b) => this.renderUnified(p, b));
			else if (blk.kind === "same") blk.lines.forEach((l, i) => line("ctx", " ", l, null, blk.o + i, blk.n + i));
			else {
				const rows = [
					...blk.del.map((l, i) => line("del", "-", l, blk.add[i] ?? null, blk.o + i, "")),
					...blk.add.map((l, i) => line("add", "+", l, blk.del[i] ?? null, "", blk.n + i)),
				];
				this.hunks.push(rows);
				this.revertButton(rows[0], blk, "undo-2");
			}
		}
	}

	/** 한 행 = [이전 줄번호 | 이전 내용 | 이후 줄번호 | 이후 내용]. 변경 블록은 짧은 쪽을 빈 칸으로 채워 높이를 맞춘다 */
	private renderSide(body: HTMLElement, blocks: Block[]) {
		const cell = (row: HTMLElement, cls: string, no: number | null, text: string | null, other: string | null) => {
			const ln = row.createSpan({ cls: "light-git-ln", text: no === null ? "" : String(no) });
			const code = row.createSpan({ cls: `light-git-code ${text === null ? "empty" : cls}` });
			if (text !== null) this.fillCode(code, text, other);
			return ln;
		};
		for (const blk of blocks) {
			if (blk.kind === "fold") {
				this.foldRow(body, blk, (p, b) => this.renderSide(p, b));
			} else if (blk.kind === "same") {
				blk.lines.forEach((l, i) => {
					const row = body.createDiv({ cls: "light-git-diff-row" });
					cell(row, "", blk.o + i, l, null);
					cell(row, "", blk.n + i, l, null);
				});
			} else {
				// 양쪽에 다 있으면 수정, 한쪽에만 있으면 추가·삭제
				const kind = !blk.del.length ? "is-inserted" : !blk.add.length ? "is-removed" : "is-modified";
				const rows: HTMLElement[] = [];
				for (let i = 0; i < Math.max(blk.del.length, blk.add.length); i++) {
					const row = body.createDiv({ cls: `light-git-diff-row ${kind}` });
					const del = i < blk.del.length ? blk.del[i] : null;
					const add = i < blk.add.length ? blk.add[i] : null;
					const ln = cell(row, "del", del === null ? null : blk.o + i, del, add);
					cell(row, "add", add === null ? null : blk.n + i, add, del);
					if (i === 0) this.revertButton(ln, blk, "chevrons-right");
					rows.push(row);
				}
				this.hunks.push(rows);
			}
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
