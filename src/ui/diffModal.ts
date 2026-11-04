import { App, Modal } from "obsidian";
import { diffComm } from "node-diff3";

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

/** 두 버전을 줄 단위로 비교. 나란히(왼쪽 이전 | 오른쪽 이후) 또는 한 줄(unified) 보기 */
export class DiffModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private oldText: string | null,
		private newText: string | null,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("light-git-diff-modal");
		this.setTitle(this.title);
		this.render(chosenMode ?? (window.innerWidth >= 900 ? "side" : "unified"));
	}

	private render(mode: DiffMode) {
		this.contentEl.empty();
		this.modalEl.toggleClass("is-side", mode === "side");
		if (isBinary(this.oldText) || isBinary(this.newText)) {
			this.contentEl.createDiv({ cls: "light-git-empty", text: "바이너리 파일은 비교할 수 없습니다." });
			return;
		}

		const bar = this.contentEl.createDiv({ cls: "light-git-diff-modes" });
		const modes: [DiffMode, string][] = [
			["side", "나란히"],
			["unified", "한 줄"],
		];
		for (const [m, label] of modes) {
			const btn = bar.createEl("button", { text: label });
			btn.toggleClass("is-active", m === mode);
			btn.onclick = () => {
				chosenMode = m;
				this.render(m);
			};
		}
		if (this.oldText === null) bar.createDiv({ cls: "light-git-diff-note", text: "새 파일" });
		if (this.newText === null) bar.createDiv({ cls: "light-git-diff-note", text: "삭제된 파일" });

		const body = this.contentEl.createDiv({ cls: `light-git-diff is-${mode}` });
		const a = this.oldText === null ? [] : this.oldText.split("\n");
		const b = this.newText === null ? [] : this.newText.split("\n");
		const blocks = diffBlocks(a, b);
		if (!blocks.some((x) => x.kind === "change")) {
			body.createDiv({ cls: "light-git-empty", text: "변경 내용이 없습니다." });
			return;
		}
		if (mode === "side") this.renderSide(body, blocks);
		else this.renderUnified(body, blocks);
	}

	/** 접힌 구간. 누르면 그 자리에서 펼친다 (전체를 다시 그리면 스크롤 위치를 잃는다) */
	private foldRow(body: HTMLElement, blk: Extract<Block, { kind: "fold" }>, draw: (parent: HTMLElement, blocks: Block[]) => void) {
		const fold = body.createDiv({ cls: "light-git-diff-fold", text: `··· ${blk.lines.length}줄 동일 ···` });
		fold.onclick = () => {
			const opened = body.createDiv();
			fold.replaceWith(opened);
			draw(opened, [{ ...blk, kind: "same" }]);
		};
	}

	private renderUnified(body: HTMLElement, blocks: Block[]) {
		const line = (cls: string, sign: string, text: string, o: number | "", n: number | "") => {
			const row = body.createDiv({ cls: `light-git-diff-line ${cls}` });
			row.createSpan({ cls: "light-git-ln", text: String(o) });
			row.createSpan({ cls: "light-git-ln", text: String(n) });
			row.createSpan({ cls: "light-git-sign", text: sign });
			row.createSpan({ cls: "light-git-code", text: text || " " });
		};
		for (const blk of blocks) {
			if (blk.kind === "fold") this.foldRow(body, blk, (p, b) => this.renderUnified(p, b));
			else if (blk.kind === "same") blk.lines.forEach((l, i) => line("ctx", " ", l, blk.o + i, blk.n + i));
			else {
				blk.del.forEach((l, i) => line("del", "-", l, blk.o + i, ""));
				blk.add.forEach((l, i) => line("add", "+", l, "", blk.n + i));
			}
		}
	}

	/** 한 행 = [이전 줄번호 | 이전 내용 | 이후 줄번호 | 이후 내용]. 변경 블록은 짧은 쪽을 빈 칸으로 채워 높이를 맞춘다 */
	private renderSide(body: HTMLElement, blocks: Block[]) {
		const cell = (row: HTMLElement, cls: string, no: number | null, text: string | null) => {
			row.createSpan({ cls: "light-git-ln", text: no === null ? "" : String(no) });
			row.createSpan({ cls: `light-git-code ${text === null ? "empty" : cls}`, text: text === null ? "" : text || " " });
		};
		for (const blk of blocks) {
			if (blk.kind === "fold") {
				this.foldRow(body, blk, (p, b) => this.renderSide(p, b));
			} else if (blk.kind === "same") {
				blk.lines.forEach((l, i) => {
					const row = body.createDiv({ cls: "light-git-diff-row" });
					cell(row, "", blk.o + i, l);
					cell(row, "", blk.n + i, l);
				});
			} else {
				for (let i = 0; i < Math.max(blk.del.length, blk.add.length); i++) {
					const row = body.createDiv({ cls: "light-git-diff-row" });
					cell(row, "del", i < blk.del.length ? blk.o + i : null, i < blk.del.length ? blk.del[i] : null);
					cell(row, "add", i < blk.add.length ? blk.n + i : null, i < blk.add.length ? blk.add[i] : null);
				}
			}
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
