import { SourceControlView } from "../../src/ui/sourceControlView";
import { HistoryView } from "../../src/ui/historyView";
(window as any).__notices = [];
(window as any).__calls = [];
const now = Date.now() / 1000;
const log = async () => [
	{ oid: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", parent: "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", parents: ["b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"], message: "vault backup: 2026-11-02 15:20 (iphone)", author: "song", timestamp: now - 300 },
	{ oid: "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", parent: "d1", parents: ["d1", "e1"], message: "Merge remote-tracking branch 'origin/main'\n\n본문 줄", author: "song", timestamp: now - 7200 },
	{ oid: "d1", parent: "c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", parents: ["c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"], message: "폰에서 고친 내용", author: "phone", timestamp: now - 8000 },
	{ oid: "e1", parent: "c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", parents: ["c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"], message: "PC에서 고친 내용", author: "desktop", timestamp: now - 9000 },
	{ oid: "c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", parents: [], message: "initial (1/3)", author: "desktop", timestamp: now - 86400 * 9 },
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
	unpushedCount: async () => 0,
	unpushedCommits: async () => ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"],
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
	unpushedCount: async () => 0,
	log,
	commitFiles,
};
// 패널 4: 충돌 사본이 있는 볼트
const copyPath = "notes/회의록 (충돌 사본 2026-11-04 1530).md";
const withCopy = {
	isRepo: async () => true,
	isMerging: async () => false,
	conflicts: async () => [],
	changes: async () => [
		{ path: "notes/a.md", type: "modified", staged: false, unstaged: true },
		{ path: copyPath, type: "added", staged: false, unstaged: true },
	],
	unpushedCount: async () => 2,
	log,
	commitFiles,
};
// 패널 5: 충돌을 다 해결한 머지 / 패널 6: 저장소 없음, URL도 없음
const merged = { ...withCopy, isMerging: async () => true, changes: async () => [{ path: "notes/회의록.md", type: "modified", staged: true, unstaged: false }], unpushedCount: async () => 0 };
const notConnected = { isRepo: async () => false };
// 패널 7: 변경 없음 / 패널 8: 변경 파일이 많은 볼트
const clean = { ...withCopy, changes: async () => [], unpushedCount: async () => 0 };
const many = {
	...clean,
	changes: async () => [
		...Array.from({ length: 8 }, (_, i) => ({ path: `notes/회의록 ${i + 1}.md`, type: "modified", staged: i === 0, unstaged: i !== 0 })),
		...Array.from({ length: 6 }, (_, i) => ({ path: `daily/2026-11-0${i + 1}.md`, type: "added", staged: false, unstaged: true })),
		{ path: "todo.md", type: "modified", staged: false, unstaged: true },
	],
};
const plugin = (backend: unknown): any => ({
	settings: { remoteUrl: "", branch: "main" },
	commitOnly: async (...args: unknown[]) => ((window as any).__calls.push(["commitOnly", ...args]), true),
	openSettings: () => (window as any).__calls.push(["openSettings"]),
	isBusy: () => false,
	runningLabel: () => (window as any).__running ?? null,
	lastRun: null,
	getBackend: async () => backend,
	defaultMessage: (n: number) => `vault backup: 2026-11-02 16:30 (desktop) ${n}개`,
	sync: async (...args: unknown[]) => ((window as any).__calls.push(["sync", ...args]), true),
	stage: (p: string[]) => (window as any).__calls.push(["stage", p]),
	unstage: (p: string[]) => (window as any).__calls.push(["unstage", p]),
	stagingDone: async () => {},
	openCopyDiff: (p: string) => (window as any).__calls.push(["openCopyDiff", p]),
	discard: (p: string) => (window as any).__calls.push(["discard", p]),
	openChangeDiff: (p: string, all: string[]) => (window as any).__calls.push(["openChangeDiff", p, all]),
	openFile: (p: string) => (window as any).__calls.push(["openFile", p]),
	openCommitDiff: (c: { oid: string }, p: string, all: string[]) => (window as any).__calls.push(["openCommitDiff", c.oid, p, all]),
	pullCommand() {}, pushCommand() {}, activateHistory() {}, connect() {}, openMerge() {},
});
const wrap = document.createElement("div");
wrap.style.cssText = "display:flex;gap:16px;align-items:flex-start";
document.body.appendChild(wrap);
const panes: [any, unknown, string][] = [
	[SourceControlView, merging, "merging"],
	[SourceControlView, staging, "staging"],
	[HistoryView, merging, "history"],
	[SourceControlView, withCopy, "copies"],
	[SourceControlView, merged, "merged"],
	[SourceControlView, notConnected, "notConnected"],
	[SourceControlView, clean, "clean"],
	[SourceControlView, many, "many"],
	[HistoryView, merging, "historyWide"],
];
for (const [V, backend, id] of panes) {
	const v = new V({ getViewState: () => ({}), togglePinned() {}, on: () => ({}) }, plugin(backend));
	const pane = document.createElement("div");
	pane.id = id;
	pane.style.cssText = `flex:none;width:${id === "historyWide" ? 900 : 300}px;height:520px;background:var(--background-primary);border-radius:8px;overflow:hidden`;
	pane.appendChild(v.contentEl);
	wrap.appendChild(pane);
	((window as any).__views ??= {})[id] = v;
	(window as any).__ready = ((window as any).__ready ?? Promise.resolve()).then(() => v.onOpen());
}

// Diff 모달 (나란히/한 줄)
import { DiffModal } from "../../src/ui/diffModal";
const before = ["# 회의록", "", "참석자: 김, 이", ...Array.from({ length: 10 }, (_, i) => `- 메모 ${i + 1}`), "결론: 다음 주", ""].join("\n");
const after = before.replace("참석자: 김, 이", "참석자: 김, 이, 박").replace("- 메모 5\n", "").replace("결론: 다음 주", "결론: 이번 주 금요일\n추가 줄");
(window as any).openDiff = () => new DiffModal({} as any, { title: "notes/회의록.md (마지막 커밋 → 현재)", oldText: before, newText: after }).open();
const long = Array.from({ length: 30 }, (_, i) => `줄 ${i + 1}`);
(window as any).openLongDiff = () => new DiffModal({} as any, { title: "notes/긴 파일.md", oldText: long.join("\n"), newText: ["첫 줄 수정", ...long.slice(1, -1), "끝 줄 수정"].join("\n") }).open();
// 파일 사이 이동 + 블록 되돌리기: saveNew는 받은 내용을 기록한다 (window.__saveOk로 실패 흉내)
const navFile = (i: number) => {
	const old = Array.from({ length: 40 }, (_, k) => `${"ABC"[i]} 줄 ${k + 1}`);
	const now = [...old];
	now[2] = `${"ABC"[i]} 줄 3 수정`;
	now[30] = `${"ABC"[i]} 줄 31 수정`;
	return {
		title: `notes/${"ABC"[i]}.md`,
		oldText: old.join("\n"),
		newText: now.join("\n"),
		openFile: () => (window as any).__calls.push(["openFile", i]),
		saveNew: async (expected: string, next: string) => {
			(window as any).__saved = { expected, next };
			return (window as any).__saveOk !== false;
		},
	};
};
(window as any).openNavDiff = () => new DiffModal({} as any, navFile(0), { count: 3, index: 0, load: async (i) => navFile(i) }).open();

// 설정 화면
import { DEFAULT_SETTINGS, LightGitSettingTab } from "../../src/settings";
const tab = new LightGitSettingTab({} as any, { settings: { ...DEFAULT_SETTINGS }, getToken: () => "", backendName: () => "자동" } as any);
tab.display();
(window as any).__settingInputs = () => Array.from(tab.containerEl.querySelectorAll("input"));
