/** 행이 보이도록 목록만 스크롤한다. scrollIntoView는 바깥 화면까지 움직인다 */
export function revealInList(list: HTMLElement, row: HTMLElement) {
	const l = list.getBoundingClientRect();
	const r = row.getBoundingClientRect();
	if (r.top < l.top) list.scrollTop -= l.top - r.top;
	else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
}

/** div로 만든 아이콘 버튼을 키보드로도 누를 수 있게 한다 */
export function asButton(el: HTMLElement, run: () => void) {
	el.setAttribute("role", "button");
	el.setAttribute("tabindex", "0");
	el.onclick = run;
	el.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		e.stopPropagation();
		run();
	});
}
