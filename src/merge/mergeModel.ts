import { diffIndices } from "node-diff3";

/**
 * IntelliJ 머지 화면의 모델.
 * 파일을 '영역(region)'으로 나눈다: 양쪽이 같은 stable 영역과, 한쪽/양쪽이 바꾼 변경 영역.
 * 각 영역마다 base(공통 조상) / ours(내 것) / theirs(원격) 줄을 모두 들고 있어서
 * 3단 화면에 나란히 보여주고, 영역별로 >>(적용) / ✕(무시)를 고를 수 있다.
 */

export type Side = "ours" | "theirs";
export type RegionKind = "stable" | "ours" | "theirs" | "same" | "conflict";

export interface Region {
	kind: RegionKind;
	base: string[];
	ours: string[];
	theirs: string[];
	/** 적용한 쪽 (적용 순서대로 결과에 이어 붙음 — IntelliJ와 동일) */
	applied: Side[];
	/** 적용 또는 무시로 처리한 쪽 */
	handled: Side[];
	/** 사용자가 결과를 직접 편집했으면 그 내용 */
	edited: string[] | null;
}

interface Hunk {
	side: Side;
	oStart: number;
	oLen: number;
	sStart: number;
	sLen: number;
}

export function splitLines(text: string): string[] {
	return text.split("\n");
}

export function joinLines(lines: string[]): string {
	return lines.join("\n");
}

function sameLines(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((l, i) => l === b[i]);
}

export function buildRegions(baseText: string, oursText: string, theirsText: string): Region[] {
	const o = splitLines(baseText);
	const a = splitLines(oursText);
	const b = splitLines(theirsText);
	const hunks: Hunk[] = [];
	for (const [side, buf] of [["ours", a], ["theirs", b]] as const) {
		for (const d of diffIndices(o, buf)) {
			hunks.push({ side, oStart: d.buffer1[0], oLen: d.buffer1[1], sStart: d.buffer2[0], sLen: d.buffer2[1] });
		}
	}
	hunks.sort((x, y) => x.oStart - y.oStart || (x.side === "ours" ? -1 : 1));

	const regions: Region[] = [];
	const push = (kind: RegionKind, base: string[], ours: string[], theirs: string[]) =>
		regions.push({ kind, base, ours, theirs, applied: [], handled: [], edited: null });

	let cur = 0;
	while (hunks.length) {
		const first = hunks.shift()!;
		const group = [first];
		const start = first.oStart;
		let end = first.oStart + first.oLen;
		// git diff3처럼 겹치거나 맞닿은 hunk는 하나의 영역으로 묶는다
		while (hunks.length && hunks[0].oStart <= end) {
			const h = hunks.shift()!;
			end = Math.max(end, h.oStart + h.oLen);
			group.push(h);
		}
		if (start > cur) {
			const stable = o.slice(cur, start);
			push("stable", stable, stable, stable);
		}
		// 영역 안에서 hunk 바깥 부분은 그 쪽도 base와 같으므로, 첫/끝 hunk 위치에서 영역 경계까지 같은 거리만큼 넓힌다
		const span = (side: Side, buf: string[]): string[] => {
			const hs = group.filter((h) => h.side === side);
			if (!hs.length) return o.slice(start, end);
			const last = hs[hs.length - 1];
			const sStart = hs[0].sStart - (hs[0].oStart - start);
			const sEnd = last.sStart + last.sLen + (end - (last.oStart + last.oLen));
			return buf.slice(sStart, sEnd);
		};
		const ours = span("ours", a);
		const theirs = span("theirs", b);
		const base = o.slice(start, end);
		const oursChanged = group.some((h) => h.side === "ours");
		const theirsChanged = group.some((h) => h.side === "theirs");
		let kind: RegionKind;
		if (oursChanged && theirsChanged) kind = sameLines(ours, theirs) ? "same" : "conflict";
		else kind = oursChanged ? "ours" : "theirs";
		push(kind, base, ours, theirs);
		cur = end;
	}
	if (cur < o.length) {
		const stable = o.slice(cur);
		push("stable", stable, stable, stable);
	}
	return regions;
}

/** 이 영역에서 사용자가 처리해야 하는 쪽 */
export function changedSides(r: Region): Side[] {
	if (r.kind === "conflict") return ["ours", "theirs"];
	if (r.kind === "ours" || r.kind === "theirs") return [r.kind];
	return [];
}

export function isResolved(r: Region): boolean {
	if (r.edited) return true;
	return changedSides(r).every((s) => r.handled.includes(s));
}

export function regionResult(r: Region): string[] {
	if (r.edited) return r.edited;
	if (r.kind === "stable" || r.kind === "same") return r.ours;
	if (!r.applied.length) return r.base;
	return r.applied.flatMap((s) => r[s]);
}

export function apply(r: Region, side: Side) {
	if (r.handled.includes(side)) return;
	r.edited = null;
	r.applied.push(side);
	r.handled.push(side);
}

export function ignore(r: Region, side: Side) {
	if (r.handled.includes(side)) return;
	r.handled.push(side);
}

export function edit(r: Region, lines: string[]) {
	r.edited = lines;
}

export function reset(r: Region) {
	r.applied = [];
	r.handled = [];
	r.edited = null;
}

/** IntelliJ "Apply non-conflicting changes" */
export function applyNonConflicting(regions: Region[]) {
	for (const r of regions) if ((r.kind === "ours" || r.kind === "theirs") && !isResolved(r)) apply(r, r.kind);
}

/** IntelliJ "Accept Left / Accept Right": 파일 전체를 한쪽 버전으로 */
export function acceptAll(regions: Region[], side: Side) {
	for (const r of regions) {
		if (!changedSides(r).length) continue;
		reset(r);
		const other: Side = side === "ours" ? "theirs" : "ours";
		// 고른 쪽이 안 바꾼 영역은 다른 쪽을 무시만 하면 결과 = base = 고른 쪽
		if (changedSides(r).includes(side)) apply(r, side);
		if (changedSides(r).includes(other)) ignore(r, other);
	}
}

export function unresolvedCount(regions: Region[]): { conflicts: number; changes: number } {
	let conflicts = 0;
	let changes = 0;
	for (const r of regions) {
		if (isResolved(r)) continue;
		if (r.kind === "conflict") conflicts++;
		else if (r.kind === "ours" || r.kind === "theirs") changes++;
	}
	return { conflicts, changes };
}

export function mergedText(regions: Region[]): string {
	return joinLines(regions.flatMap(regionResult));
}
