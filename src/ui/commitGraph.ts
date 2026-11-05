/** 커밋 한 행의 그래프: lane = 점이 놓이는 칸, top/bottom = 행 위쪽·아래쪽 절반의 선 [시작 칸, 끝 칸] */
export interface GraphRow {
	lane: number;
	top: [number, number][];
	bottom: [number, number][];
}

/**
 * 최신 커밋부터 순서대로 받아 칸을 배정한다. active[i] = i번째 칸이 다음에 만날 커밋.
 * 목록에 없는 부모(더 오래된 커밋, shallow 경계)는 선이 아래로 나간 채 끝난다.
 */
export function commitGraph(commits: { oid: string; parents: string[] }[]): GraphRow[] {
	const active: (string | null)[] = [];
	const free = () => {
		const i = active.indexOf(null);
		return i >= 0 ? i : active.length;
	};
	return commits.map((c) => {
		let lane = active.indexOf(c.oid);
		if (lane < 0) lane = free();
		const top: [number, number][] = [];
		active.forEach((oid, i) => {
			if (oid === null) return;
			if (oid === c.oid) {
				top.push([i, lane]);
				active[i] = null;
			} else top.push([i, i]);
		});
		const bottom: [number, number][] = [];
		const passing = active.map((oid) => oid !== null);
		c.parents.forEach((p, idx) => {
			const known = active.indexOf(p);
			if (known >= 0) return void bottom.push([lane, known]);
			const to = idx === 0 ? lane : free();
			active[to] = p;
			bottom.push([lane, to]);
		});
		passing.forEach((on, i) => {
			if (on) bottom.push([i, i]);
		});
		while (active.length && active[active.length - 1] === null) active.pop();
		return { lane, top, bottom };
	});
}
