import { acceptAll, apply, applyNonConflicting, buildRegions, ignore, mergedText, unresolvedCount, edit } from "../src/merge/mergeModel";

export function runMergeModelTests(check: (name: string, cond: boolean, detail?: string) => void) {
	const base = "a\nb\nc\nd\ne\nf\ng\n";
	const ours = "a\nB-ours\nc\nd\ne\nF-ours\ng\n"; // b, f 수정
	const theirs = "a\nb\nc\nD-theirs\ne\nF-theirs\ng\nh\n"; // d, f 수정 + h 추가

	let r = buildRegions(base, ours, theirs);
	const kinds = r.map((x) => x.kind).join(",");
	check("regions: ours / theirs / conflict / theirs(add)", kinds === "stable,ours,stable,theirs,stable,conflict,stable,theirs,stable", kinds);
	check("initial result is base", mergedText(r) === base);
	check("initial unresolved", JSON.stringify(unresolvedCount(r)) === '{"conflicts":1,"changes":3}', JSON.stringify(unresolvedCount(r)));

	applyNonConflicting(r);
	check("apply non-conflicting", mergedText(r) === "a\nB-ours\nc\nD-theirs\ne\nf\ng\nh\n", JSON.stringify(mergedText(r)));
	const conflict = r.find((x) => x.kind === "conflict")!;
	apply(conflict, "theirs");
	apply(conflict, "ours");
	check("apply both sides appends in click order", mergedText(r) === "a\nB-ours\nc\nD-theirs\ne\nF-theirs\nF-ours\ng\nh\n");
	check("all resolved", unresolvedCount(r).conflicts === 0 && unresolvedCount(r).changes === 0);

	r = buildRegions(base, ours, theirs);
	acceptAll(r, "ours");
	check("accept all ours == ours file", mergedText(r) === ours);
	acceptAll(r, "theirs");
	check("accept all theirs == theirs file", mergedText(r) === theirs);

	r = buildRegions(base, ours, theirs);
	const c2 = r.find((x) => x.kind === "conflict")!;
	ignore(c2, "ours");
	check("half-handled conflict still unresolved", unresolvedCount(r).conflicts === 1);
	edit(c2, ["F-manual"]);
	check("manual edit resolves", unresolvedCount(r).conflicts === 0 && mergedText(r).includes("F-manual"));

	// 같은 변경을 양쪽이 한 경우 → 충돌 아님
	r = buildRegions("x\ny\n", "x\nY\n", "x\nY\n");
	check("identical change on both sides is not a conflict", r.some((x) => x.kind === "same") && unresolvedCount(r).conflicts === 0 && mergedText(r) === "x\nY\n");

	// 빈 base (양쪽에서 새로 만든 파일)
	r = buildRegions("", "mine\n", "theirs\n");
	check("both-added file is one conflict", unresolvedCount(r).conflicts === 1);

	// 큰 파일에서도 결과가 정확한지: 랜덤 편집 후 accept all
	const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
	const o2 = lines.join("\n");
	const a2 = lines.map((l, i) => (i % 37 === 0 ? l + " ours" : l)).join("\n");
	const b2 = lines.filter((_, i) => i % 53 !== 0).join("\n");
	r = buildRegions(o2, a2, b2);
	acceptAll(r, "ours");
	const okA = mergedText(r) === a2;
	acceptAll(r, "theirs");
	check("random edits: accept all reproduces each side", okA && mergedText(r) === b2);
}
