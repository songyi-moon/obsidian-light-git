import { SourceControlView } from "../../src/ui/sourceControlView";
import { HistoryView } from "../../src/ui/historyView";
(window as any).__notices = [];
(window as any).__calls = [];
const now = Date.now() / 1000;
const log = async () => [
	{ oid: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", parent: "x", message: "vault backup: 2026-11-02 15:20 (iphone)", author: "song", timestamp: now - 300 },
	{ oid: "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", parent: "y", message: "Merge remote-tracking branch 'origin/main'", author: "song", timestamp: now - 7200 },
	{ oid: "c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", message: "initial (1/3)", author: "desktop", timestamp: now - 86400 * 9 },
];
const commitFiles = async () => [{ path: "notes/a.md", type: "modified" }, { path: "notes/b.md", type: "deleted" }];

// 패널 1: 머지 중 (충돌 있음)
const merging = {
	isRepo: async () => true,
	isMerging: async () => true,
	conflicts: async () => ["notes/회의록.md"],
	changes: async () => [
		{ path: "notes/회의록.md", type: "modified", staged: false, unstaged: true },
		{ path: "daily/2026-11-02.md", type: "added", staged: false, unstaged: true },
		{ path: "inbox/아이디어 정리하기 아주 긴 파일 이름 테스트.md", type: "modified", staged: false, unstaged: true },
		{ path: "old.md", type: "deleted", staged: false, unstaged: true },
	],
	log,
	commitFiles,
};
// 패널 2: 일부 스테이징 (notes/b.md는 스테이징 후 다시 수정 → 양쪽에 표시)
const staging = {
	isRepo: async () => true,
	isMerging: async () => false,
	conflicts: async () => [],
	changes: async () => [
		{ path: "notes/a.md", type: "modified", staged: true, unstaged: false },
		{ path: "notes/b.md", type: "modified", staged: true, unstaged: true },
		{ path: "daily/2026-11-03.md", type: "added", staged: false, unstaged: true },
		{ path: "old.md", type: "deleted", staged: false, unstaged: true },
	],
	log,
	commitFiles,
};
const plugin = (backend: unknown): any => ({
	isBusy: () => false,
	getBackend: async () => backend,
	defaultMessage: (n: number) => `vault backup: 2026-11-02 16:30 (desktop) ${n}개`,
	sync: async (...args: unknown[]) => ((window as any).__calls.push(["sync", ...args]), true),
	stage: (p: string[]) => (window as any).__calls.push(["stage", p]),
	unstage: (p: string[]) => (window as any).__calls.push(["unstage", p]),
	pullCommand() {}, pushCommand() {}, activateHistory() {}, connect() {}, openMerge() {}, openChangeDiff() {}, openFile() {}, discard() {}, openCommitDiff() {},
});
const wrap = document.createElement("div");
wrap.style.cssText = "display:flex;gap:16px;align-items:flex-start";
document.body.appendChild(wrap);
const panes: [any, unknown, string][] = [
	[SourceControlView, merging, "merging"],
	[SourceControlView, staging, "staging"],
	[HistoryView, merging, "history"],
];
for (const [V, backend, id] of panes) {
	const v = new V({ getViewState: () => ({}), togglePinned() {}, on: () => ({}) }, plugin(backend));
	const pane = document.createElement("div");
	pane.id = id;
	pane.style.cssText = "width:300px;height:520px;background:var(--background-primary);border-radius:8px;overflow:hidden";
	pane.appendChild(v.contentEl);
	wrap.appendChild(pane);
	(window as any).__ready = ((window as any).__ready ?? Promise.resolve()).then(() => v.onOpen());
}

// Diff 모달 (나란히/한 줄)
import { DiffModal } from "../../src/ui/diffModal";
const before = ["# 회의록", "", "참석자: 김, 이", ...Array.from({ length: 10 }, (_, i) => `- 메모 ${i + 1}`), "결론: 다음 주", ""].join("\n");
const after = before.replace("참석자: 김, 이", "참석자: 김, 이, 박").replace("- 메모 5\n", "").replace("결론: 다음 주", "결론: 이번 주 금요일\n추가 줄");
(window as any).openDiff = () => new DiffModal({} as any, "notes/회의록.md (마지막 커밋 → 현재)", before, after).open();
