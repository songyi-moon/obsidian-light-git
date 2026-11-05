import { setIcon, type ItemView } from "obsidian";
import { asButton } from "./asButton";

/** 툴바에 탭 고정(핀) 토글 버튼. 고정 상태가 바뀌면(탭 메뉴에서 바꿔도) 아이콘이 따라간다 */
export function addPinButton(view: ItemView, bar: HTMLElement) {
	const btn = bar.createDiv({ cls: "clickable-icon light-git-icon" });
	const update = (pinned: boolean) => {
		setIcon(btn, pinned ? "pin-off" : "pin");
		btn.setAttribute("aria-label", pinned ? "고정 해제" : "고정");
		btn.toggleClass("is-active", pinned);
	};
	update(!!view.leaf.getViewState().pinned);
	asButton(btn, () => view.leaf.togglePinned());
	view.registerEvent(view.leaf.on("pinned-change", update));
}
