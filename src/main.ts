import "./polyfill";
import { debounce, FileSystemAdapter, Notice, Platform, Plugin, TFile } from "obsidian";
import { CommitMessageModal } from "./commitModal";
import { friendlyError, remoteUrlProblem } from "./git/errors";
import { IsoBackend } from "./git/isoBackend";
import { NativeBackend } from "./git/nativeBackend";
import { ObsidianFs } from "./git/obsidianFs";
import { obsidianHttp } from "./git/obsidianHttp";
import { conflictCopyOriginal, isNewConflictCopy, type CommitInfo, type GitBackend, type GitConfig, type WorkChange } from "./git/types";
import { MergeModal, type MergeHost } from "./merge/mergeModal";
import { DEFAULT_SETTINGS, LightGitSettingTab, type LightGitSettings } from "./settings";
import { ConfirmModal } from "./ui/confirmModal";
import { DiffModal, type DiffContent, type DiffFiles } from "./ui/diffModal";
import { HISTORY_VIEW, HistoryView } from "./ui/historyView";
import { SOURCE_CONTROL_VIEW, SourceControlView } from "./ui/sourceControlView";

const TOKEN_KEY = "light-git-token";
/** 같은 볼트를 동기화하는 다른 플러그인. 둘이 같이 돌면 같은 파일·저장소를 동시에 고쳐서 꼬인다. */
const OBSIDIAN_GIT = "obsidian-git";

/** Obsidian 내부 API (공개 타입에 없음). 없거나 바뀌었을 수 있으므로 모두 선택적으로 다룬다. */
interface PluginManager {
	enabledPlugins?: Set<string>;
	disablePluginAndSave?: (id: string) => Promise<void>;
}

interface SettingManager {
	open?: () => void;
	openTabById?: (id: string) => void;
}

const pad = (n: number) => String(n).padStart(2, "0");
function now(withDate = true): string {
	const d = new Date();
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return withDate ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}` : time;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default class LightGitPlugin extends Plugin implements MergeHost {
	settings!: LightGitSettings;
	private backend: GitBackend | null = null;
	private busy = false;
	/** 진행 중인 작업 이름 */
	private running: string | null = null;
	/** 뷰 상단에 보여 줄 마지막 작업 결과 (알림이 사라진 뒤에도 알 수 있게) */
	lastRun: { text: string; failed: boolean } | null = null;
	/** 충돌 안내는 자동으로 닫히지 않으므로, 충돌을 다 해결하면 직접 닫는다 */
	private conflictNotice: Notice | null = null;
	private staging: Promise<void> = Promise.resolve();
	private progressNotice: Notice | null = null;
	/** 모바일에서 직접 실행한 작업이 끝날 때까지 띄워 두는 문구. 세부 진행 알림이 끝나면 이 문구로 돌아온다 */
	private progressBase: string | null = null;
	private statusEl: HTMLElement | null = null;
	private autoSyncTimer: number | null = null;

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.addSettingTab(new LightGitSettingTab(this.app, this));
		this.registerView(SOURCE_CONTROL_VIEW, (leaf) => new SourceControlView(leaf, this));
		this.registerView(HISTORY_VIEW, (leaf) => new HistoryView(leaf, this));
		if (!Platform.isMobile) this.statusEl = this.addStatusBarItem();
		this.setStatus("Git: 대기");

		this.addRibbonIcon("refresh-cw", "Git 동기화", () => this.manualSync());
		this.addRibbonIcon("git-branch", "Git 변경 사항", () => this.activateView(SOURCE_CONTROL_VIEW));
		this.addCommand({ id: "sync", name: "커밋 & 동기화", callback: () => this.manualSync() });
		this.addCommand({ id: "sync-default", name: "커밋 & 동기화 (기본 메시지)", callback: () => this.sync() });
		this.addCommand({ id: "commit", name: "커밋 (올리지 않음)", callback: () => this.commitOnly() });
		this.addCommand({ id: "pull", name: "Pull", callback: () => this.pullCommand() });
		this.addCommand({ id: "push", name: "Push", callback: () => this.pushCommand() });
		this.addCommand({ id: "connect", name: "원격 저장소 연결", callback: () => this.connect() });
		this.addCommand({ id: "open-source-control", name: "변경 사항(Source Control) 열기", callback: () => this.activateView(SOURCE_CONTROL_VIEW) });
		this.addCommand({ id: "open-history", name: "History 열기", callback: () => this.activateHistory() });
		this.addCommand({ id: "resolve-conflicts", name: "충돌 해결", callback: () => this.resolveNextConflict() });

		// 파일이 바뀌면 열려 있는 Git 뷰를 갱신 (연속 저장은 묶어서 한 번)
		const refresh = debounce(() => this.refreshViews(), 1500, true);
		for (const ev of ["modify", "create", "delete", "rename"] as const) {
			// 저장소 폴더 밖(.obsidian 등) 변경은 무시
			this.registerEvent(this.app.vault.on(ev as "rename", (f, oldPath) => (this.inRepo(f.path) || (oldPath && this.inRepo(oldPath))) && refresh()));
		}

		this.app.workspace.onLayoutReady(() => {
			const otherGit = this.obsidianGitEnabled();
			if (this.settings.remoteUrl && otherGit) {
				new Notice("Light Git: obsidian-git이 켜져 있어 자동 pull/동기화를 건너뜁니다. 한 플러그인만 쓰세요 (설정 > 원격 저장소 연결에서 끌 수 있습니다).", 10000);
			}
			if (this.settings.pullOnStartup && this.settings.remoteUrl && !otherGit) {
				this.run(
					"pull",
					async (b) => {
						if (!(await b.isRepo())) return null;
						// 첫 clone을 다 못 받은 상태(HEAD 없음)면 자동으로 이어받지 않는다 — 큰 저장소에서 켤 때마다 꺼지는 원인
						const cloned = await b.log(1).then((l) => l.length > 0, () => false);
						return cloned ? this.afterPull(await b.pull()) : null;
					},
					true,
				);
			}
			this.scheduleAutoSync();
		});
	}

	onunload() {
		if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// 토큰은 data.json(= vault 안, git에 올라감)이 아니라 기기별 localStorage에 둔다.
	getToken(): string {
		return (this.app.loadLocalStorage(TOKEN_KEY) as string | null) ?? "";
	}

	setToken(token: string) {
		this.app.saveLocalStorage(TOKEN_KEY, token || null);
	}

	private gitConfig(): GitConfig {
		const s = this.settings;
		return {
			remoteUrl: s.remoteUrl,
			branch: s.branch || "main",
			username: s.username,
			token: this.getToken(),
			authorName: s.authorName,
			authorEmail: s.authorEmail,
			chunkBytes: s.chunkMB * 1024 * 1024,
		};
	}

	/** git 저장소로 쓰는 vault 하위 폴더 ("" = vault 전체) */
	repoDir(): string {
		return (this.settings.repoFolder ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	}

	/** 저장소 기준 경로 → vault 경로 */
	vaultPath(repoPath: string): string {
		const dir = this.repoDir();
		return dir ? `${dir}/${repoPath}` : repoPath;
	}

	private inRepo(vaultPath: string): boolean {
		const dir = this.repoDir();
		return !dir || vaultPath === dir || vaultPath.startsWith(dir + "/");
	}

	resetBackend() {
		this.backend = null;
	}

	backendName(): string {
		return this.backend?.name ?? "(아직 선택 안 됨)";
	}

	isBusy(): boolean {
		return this.busy;
	}

	runningLabel(): string | null {
		return this.running;
	}

	async getBackend(): Promise<GitBackend> {
		if (this.backend) return this.backend;
		const adapter = this.app.vault.adapter;
		const choice = this.settings.backend;
		const dir = this.repoDir();
		if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
		if (choice !== "isomorphic" && Platform.isDesktopApp && adapter instanceof FileSystemAdapter) {
			const cwd = dir ? `${adapter.getBasePath()}/${dir}` : adapter.getBasePath();
			if (await NativeBackend.available(cwd)) {
				this.backend = new NativeBackend(cwd, () => this.gitConfig());
				return this.backend;
			}
			if (choice === "native") throw new Error("git 실행 파일을 찾을 수 없습니다.");
		}
		const gitFs = new ObsidianFs(adapter, dir);
		if (await adapter.exists(dir ? `${dir}/.lightgit/config` : ".lightgit/config")) gitFs.gitDir = ".lightgit";
		this.backend = new IsoBackend(gitFs, obsidianHttp, () => this.gitConfig(), "/", (msg) => this.showProgress(msg));
		return this.backend;
	}

	scheduleAutoSync() {
		if (this.autoSyncTimer !== null) window.clearInterval(this.autoSyncTimer);
		this.autoSyncTimer = null;
		const min = this.settings.autoSyncMinutes;
		if (min > 0) {
			this.autoSyncTimer = window.setInterval(() => {
				if (!this.obsidianGitEnabled()) this.sync(undefined, true);
			}, min * 60 * 1000);
			this.registerInterval(this.autoSyncTimer);
		}
	}

	private setStatus(text: string) {
		this.statusEl?.setText(text);
	}

	defaultMessage(numFiles: number): string {
		const s = this.settings;
		return s.commitTemplate
			.replace(/\{\{date\}\}/g, now())
			.replace(/\{\{device\}\}/g, s.deviceName || (Platform.isMobile ? "mobile" : "desktop"))
			.replace(/\{\{numFiles\}\}/g, String(numFiles));
	}

	/** 충돌이 났으면 변경 사항 뷰를 열어 바로 해결할 수 있게 한다 */
	private afterPull(conflicts: string[]): string {
		if (!conflicts.length) return "pull 완료";
		this.activateView(SOURCE_CONTROL_VIEW);
		return `충돌 ${conflicts.length}건 — 'Git 변경 사항'에서 파일을 눌러 해결하세요:\n${conflicts.join("\n")}`;
	}

	/** 공통 실행기: 동시 실행 방지 + 상태 표시 + 에러 알림. 성공 여부를 반환. */
	async run(label: string, fn: (b: GitBackend) => Promise<string | null>, quiet = false): Promise<boolean> {
		if (this.busy) {
			if (!quiet) new Notice("Git 작업이 이미 진행 중입니다.");
			return false;
		}
		this.busy = true;
		this.running = label;
		this.setStatus(`Git: ${label}…`);
		this.renderViewStatus();
		// 노트 화면에서 실행하면 뷰의 상태 줄이 안 보이므로 모바일은 알림으로도 알린다 (자동 실행은 조용히)
		if (!quiet && Platform.isMobile) {
			this.progressBase = `Git: ${label} 중…`;
			this.showProgress(null);
		}
		let ok = false;
		try {
			const result = await fn(await this.getBackend());
			if (result?.startsWith("충돌")) {
				this.conflictNotice?.hide();
				this.conflictNotice = new Notice(result, 0);
			} else if (result) new Notice(result, 4000);
			this.lastRun = { text: `${now(false)} ${label} 완료`, failed: false };
			this.setStatus(`Git: ${this.lastRun.text}`);
			ok = true;
		} catch (e) {
			console.error("[light-git]", e);
			this.errorNotice(`Git ${label} 실패`, errorText(e));
			this.lastRun = { text: `${now(false)} ${label} 실패`, failed: true };
			this.setStatus(`Git: ${label} 실패`);
		} finally {
			this.busy = false;
			this.running = null;
			this.progressBase = null;
			this.showProgress(null);
		}
		this.renderViewStatus();
		this.refreshViews();
		return ok;
	}

	private errorNotice(title: string, raw: string) {
		const { message, settings } = friendlyError(raw);
		if (!settings) return void new Notice(`${title}: ${message}`, 10000);
		this.settingsNotice(`${title}: ${message}`);
	}

	/** 설정에서 고칠 수 있는 문제: 알림에 설정 바로가기를 붙인다 */
	private settingsNotice(text: string) {
		const body = document.createDocumentFragment();
		body.append(text);
		const button = document.createElement("button");
		button.textContent = "설정 열기";
		button.className = "light-git-notice-btn";
		button.onclick = () => this.openSettings();
		body.append(button);
		new Notice(body, 10000);
	}

	openSettings() {
		const setting = (this.app as unknown as { setting?: SettingManager }).setting;
		if (!setting?.open || !setting.openTabById) return void new Notice("설정 > 커뮤니티 플러그인 > Light Git에서 변경하세요.");
		setting.open();
		setting.openTabById(this.manifest.id);
	}

	/** URL이 잘못됐으면 네트워크를 쓰기 전에 알려 준다 */
	private remoteReady(): boolean {
		const problem = remoteUrlProblem(this.settings.remoteUrl, Platform.isMobile);
		if (problem) this.settingsNotice(problem);
		return !problem;
	}

	testConnection() {
		if (!this.remoteReady()) return Promise.resolve(false);
		const branch = this.settings.branch || "main";
		return this.run("연결 테스트", async (b) =>
			(await b.checkRemote()) ? `연결 성공: 원격에 ${branch} 브랜치가 있습니다.` : `연결 성공: 원격에 ${branch} 브랜치가 아직 없어 첫 동기화 때 만들어집니다.`,
		);
	}

	private renderViewStatus() {
		for (const leaf of this.app.workspace.getLeavesOfType(SOURCE_CONTROL_VIEW)) {
			if (leaf.view instanceof SourceControlView) leaf.view.renderStatus();
		}
	}

	private pluginManager(): PluginManager | null {
		return ((this.app as unknown as { plugins?: PluginManager }).plugins ?? null) as PluginManager | null;
	}

	obsidianGitEnabled(): boolean {
		return !!this.pluginManager()?.enabledPlugins?.has(OBSIDIAN_GIT);
	}

	/** obsidian-git이 켜져 있으면 끌지 먼저 묻는다 (.git 폴더와 설정은 건드리지 않음) */
	connect() {
		if (!this.remoteReady()) return Promise.resolve(false);
		const doConnect = () => this.run("연결", (b) => b.connect());
		if (!this.obsidianGitEnabled()) return doConnect();
		new ConfirmModal(
			this.app,
			"obsidian-git 플러그인이 켜져 있습니다. 두 플러그인이 같은 볼트를 동시에 동기화하면 파일이 꼬이거나 저장소가 깨질 수 있습니다.\n" +
				"obsidian-git을 끄고 연결할까요? obsidian-git의 .git 폴더와 설정은 그대로 두며, Light Git은 .lightgit 폴더에 따로 저장소를 만듭니다.",
			"끄고 연결",
			async () => {
				try {
					const pm = this.pluginManager();
					if (!pm?.disablePluginAndSave) throw new Error("이 Obsidian 버전에서는 자동으로 끌 수 없습니다.");
					await pm.disablePluginAndSave(OBSIDIAN_GIT);
				} catch (e) {
					console.error("[light-git] obsidian-git 끄기 실패", e);
					new Notice(`obsidian-git을 끄지 못했습니다: ${errorText(e)}\n설정 > 커뮤니티 플러그인에서 직접 끈 뒤 다시 연결하세요.`, 10000);
					return;
				}
				new Notice("obsidian-git을 껐습니다. 연결을 시작합니다.");
				await doConnect();
			},
		).open();
		return Promise.resolve(false);
	}

	pullCommand() {
		return this.run("pull", async (b) => this.afterPull(await b.pull()));
	}

	pushCommand() {
		return this.run("push", async (b) => (await b.push(), "push 완료"));
	}

	/** 수동 동기화: 설정에 따라 메시지 입력창을 띄운다. 스테이징된 파일이 있으면 그것만 커밋. */
	async manualSync() {
		if (this.busy) return void new Notice("Git 작업이 이미 진행 중입니다.");
		let changes: WorkChange[] = [];
		try {
			const b = await this.getBackend();
			if (await b.isRepo()) changes = (await b.changes()).filter((c) => !isNewConflictCopy(c));
		} catch (e) {
			console.error("[light-git]", e);
		}
		const stagedOnly = changes.some((c) => c.staged);
		const count = stagedOnly ? changes.filter((c) => c.staged).length : changes.length;
		// 커밋할 게 없거나 입력창을 끈 경우 바로 동기화
		if (count === 0 || !this.settings.askMessageOnManualSync) return this.sync(undefined, false, stagedOnly);
		new CommitMessageModal(this.app, this.defaultMessage(count), count, (msg) => this.sync(msg, false, stagedOnly)).open();
	}

	stage(paths: string[]) {
		return this.enqueueStaging((b) => b.stage(paths));
	}

	unstage(paths: string[]) {
		return this.enqueueStaging((b) => b.unstage(paths));
	}

	/** 체크박스는 연달아 눌리므로 버리지 않고 순서대로 처리한다. 화면은 뷰가 먼저 바꿔 두고, 실패했을 때만 다시 읽는다. */
	private enqueueStaging(fn: (b: GitBackend) => Promise<void>) {
		if (this.busy) {
			new Notice("Git 작업이 이미 진행 중입니다.");
			this.refreshViews();
			return this.staging;
		}
		this.staging = this.staging.then(async () => fn(await this.getBackend())).catch((e) => {
			new Notice(`Git 스테이징 실패: ${errorText(e)}`, 10000);
			this.refreshViews();
		});
		return this.staging;
	}

	/** 오래 걸리는 작업(분할 clone)의 진행 상황을 알림 하나로 갱신. null이면 닫는다 */
	private showProgress(msg: string | null) {
		const text = msg ?? this.progressBase;
		if (text === null) {
			this.progressNotice?.hide();
			this.progressNotice = null;
		} else if (this.progressNotice) this.progressNotice.setMessage(text);
		else this.progressNotice = new Notice(text, 0);
	}

	/** 대기 중인 스테이징이 끝날 때까지 (상태를 읽거나 커밋하기 전에) */
	stagingDone(): Promise<void> {
		return this.staging;
	}

	/** 커밋만 하고 올리지 않는다 (IntelliJ Commit). 나중에 동기화하면 함께 올라간다. */
	commitOnly(message?: string, stagedOnly = false): Promise<boolean> {
		return this.run("커밋", async (b) => {
			if (!(await b.isRepo())) return "먼저 설정에서 '원격 저장소 연결'을 실행하세요.";
			await this.staging;
			const committed = await b.commit(message ?? ((n: number) => this.defaultMessage(n)), stagedOnly);
			return committed ? `커밋 완료 (${committed}개). 동기화하면 원격에 올라갑니다.` : "커밋할 변경이 없습니다.";
		});
	}

	/** commit → pull(merge) → push. stagedOnly면 스테이징된 파일만 커밋 (자동 동기화는 항상 전체). */
	sync(message?: string, quiet = false, stagedOnly = false): Promise<boolean> {
		return this.run(
			"동기화",
			async (b) => {
				if (!(await b.isRepo())) return quiet ? null : "먼저 설정에서 '원격 저장소 연결'을 실행하세요.";
				// 기본 메시지의 {{numFiles}}는 커밋할 때 센다 (상태 확인을 두 번 하지 않으려고)
				const msg = message ?? ((n: number) => this.defaultMessage(n));
				await this.staging; // 방금 누른 체크박스까지 반영된 뒤 커밋
				const committed = await b.commit(msg, stagedOnly);
				const conflicts = await b.pull();
				if (conflicts.length) return this.afterPull(conflicts);
				await b.push();
				return quiet && committed === 0 ? null : `동기화 완료 (커밋 ${committed}개)`;
			},
			quiet,
		);
	}

	// ---------- 뷰 ----------

	async activateView(type: string) {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(type)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type, active: true });
		}
		workspace.revealLeaf(leaf);
	}

	/** PC는 IntelliJ Log처럼 넓은 탭에, 모바일은 사이드바에 연다. 이미 열려 있으면 그 자리로 */
	async activateHistory() {
		const { workspace } = this.app;
		if (Platform.isMobile || workspace.getLeavesOfType(HISTORY_VIEW).length) return this.activateView(HISTORY_VIEW);
		const leaf = workspace.getLeaf("tab");
		await leaf.setViewState({ type: HISTORY_VIEW, active: true });
		workspace.revealLeaf(leaf);
	}

	refreshViews() {
		if (this.busy) return;
		for (const type of [SOURCE_CONTROL_VIEW, HISTORY_VIEW]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) {
				const view = leaf.view;
				if (view instanceof SourceControlView || view instanceof HistoryView) view.refresh();
			}
		}
	}

	openFile(path: string) {
		const file = this.app.vault.getAbstractFileByPath(this.vaultPath(path));
		if (file instanceof TFile) this.app.workspace.getLeaf(false).openFile(file);
		else new Notice("Obsidian에서 열 수 없는 파일입니다 (숨김 폴더 등).");
	}

	/** 목록의 파일 사이를 오갈 수 있게 한다 (하나면 목록 없음) */
	private diffFiles(path: string, paths: string[], load: (path: string) => Promise<DiffContent>): DiffFiles | undefined {
		if (paths.length < 2) return undefined;
		return { count: paths.length, index: Math.max(paths.indexOf(path), 0), load: (i) => load(paths[i]) };
	}

	private changeContent = async (path: string): Promise<DiffContent> => {
		const b = await this.getBackend();
		const adapter = this.app.vault.adapter;
		const vp = this.vaultPath(path);
		return {
			title: `${path} (마지막 커밋 → 현재)`,
			oldText: await b.readAt("HEAD", path),
			newText: (await adapter.exists(vp)) ? await adapter.read(vp) : null,
			openFile: () => this.openFile(path),
			// 머지 중에는 변경 전체가 머지 커밋에 들어가므로 변경 목록처럼 되돌리기를 막는다
			saveNew: (await b.isMerging()) ? undefined : (expected, next) => this.saveReverted(vp, expected, next),
		};
	};

	/** Diff 창이 연 뒤 파일이 바뀌었으면 쓰지 않는다 (방금 고친 내용을 옛 내용으로 덮어쓰지 않도록) */
	private async saveReverted(vaultPath: string, expected: string, next: string): Promise<boolean> {
		const changed = () => void new Notice("Diff를 연 뒤 파일이 바뀌었습니다. 다시 열어 주세요.");
		if (this.busy) {
			new Notice("Git 작업이 이미 진행 중입니다.");
			return false;
		}
		const { vault } = this.app;
		const file = vault.getAbstractFileByPath(vaultPath);
		try {
			if (file instanceof TFile) {
				let same = true;
				await vault.process(file, (cur) => {
					same = cur === expected;
					return same ? next : cur;
				});
				if (!same) changed();
				return same;
			}
			if ((await vault.adapter.read(vaultPath)) !== expected) {
				changed();
				return false;
			}
			await vault.adapter.write(vaultPath, next);
			this.refreshViews(); // 숨김 폴더 파일은 볼트 이벤트가 오지 않는다
			return true;
		} catch (e) {
			new Notice(`되돌리기 실패: ${errorText(e)}`);
			return false;
		}
	}

	async openChangeDiff(path: string, paths: string[] = [path]) {
		try {
			new DiffModal(this.app, await this.changeContent(path), this.diffFiles(path, paths, this.changeContent)).open();
		} catch (e) {
			new Notice(`diff 실패: ${errorText(e)}`);
		}
	}

	async openCopyDiff(copy: string) {
		try {
			const adapter = this.app.vault.adapter;
			const read = async (p: string) => ((await adapter.exists(this.vaultPath(p))) ? await adapter.read(this.vaultPath(p)) : null);
			const original = conflictCopyOriginal(copy);
			new DiffModal(this.app, { title: `${original} (현재 → 충돌 사본)`, oldText: await read(original), newText: await read(copy), openFile: () => this.openFile(copy) }).open();
		} catch (e) {
			new Notice(`diff 실패: ${errorText(e)}`);
		}
	}

	async openCommitDiff(c: CommitInfo, path: string, paths: string[] = [path]) {
		try {
			const b = await this.getBackend();
			const load = async (p: string): Promise<DiffContent> => ({
				title: `${p} @ ${c.oid.slice(0, 7)}`,
				oldText: c.parent ? await b.readAt(c.parent, p) : null,
				newText: await b.readAt(c.oid, p),
				openFile: () => this.openFile(p),
			});
			new DiffModal(this.app, await load(path), this.diffFiles(path, paths, load)).open();
		} catch (e) {
			new Notice(`diff 실패: ${errorText(e)}`);
		}
	}

	discard(path: string) {
		return this.run("되돌리기", async (b) => (await b.discard(path), `${path} 변경을 버렸습니다.`));
	}

	// ---------- 충돌 해결 ----------

	async openMerge(path: string) {
		try {
			const b = await this.getBackend();
			new MergeModal(this.app, this, path, await b.conflictVersions(path)).open();
		} catch (e) {
			new Notice(`충돌 정보를 읽지 못했습니다: ${errorText(e)}`);
		}
	}

	async resolveNextConflict() {
		const b = await this.getBackend();
		const conflicts = (await b.isRepo()) ? await b.conflicts() : [];
		if (!conflicts.length) return void new Notice("해결할 충돌이 없습니다.");
		await this.openMerge(conflicts[0]);
	}

	/** MergeHost: 머지 화면 결과 저장 → 해결 표시 */
	async saveResolution(repoPath: string, content: string | null): Promise<void> {
		const { vault } = this.app;
		const path = this.vaultPath(repoPath);
		const file = vault.getAbstractFileByPath(path);
		if (content === null) {
			if (file instanceof TFile) await vault.delete(file);
			else if (await vault.adapter.exists(path)) await vault.adapter.remove(path);
		} else if (file instanceof TFile) {
			// 에디터에 열려 있어도 즉시 반영되도록 vault API 사용
			await vault.modify(file, content);
		} else {
			const dir = path.slice(0, path.lastIndexOf("/"));
			if (dir && !(await vault.adapter.exists(dir))) await vault.adapter.mkdir(dir);
			await vault.adapter.write(path, content);
		}
		const b = await this.getBackend();
		await b.markResolved(repoPath);
		const left = await b.conflicts();
		if (!left.length) {
			this.conflictNotice?.hide();
			this.conflictNotice = null;
		}
		new Notice(left.length ? `해결됨. 남은 충돌 ${left.length}건` : "모든 충돌을 해결했습니다. '머지 완료 & 동기화'를 누르세요.");
		this.refreshViews();
	}

	/** MergeHost: 머지 화면이 닫힌 뒤 다음 충돌을 열고, 다 끝났으면 머지를 마칠 수 있는 뷰로 간다 */
	async afterResolution() {
		try {
			const b = await this.getBackend();
			const [next] = await b.conflicts();
			if (next) await this.openMerge(next);
			else await this.activateView(SOURCE_CONTROL_VIEW);
		} catch (e) {
			new Notice(`충돌 정보를 읽지 못했습니다: ${errorText(e)}`);
		}
	}
}
