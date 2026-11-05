import * as git from "isomorphic-git";
import { fetchTreesOnly, partialFetch, type PartialFetchOptions } from "./partialFetch";
import { applyNonConflicting, buildRegions, conflictMarkerText, mergedText } from "../merge/mergeModel";
import { isNewConflictCopy, messageText, type CommitInfo, type CommitMessage, type ConflictVersions, type FileChange, type GitBackend, type GitConfig, type WorkChange } from "./types";

/** 분할 push 때 커밋 하나를 가리키는 로컬 전용 임시 ref (원격에는 생기지 않음) */
const TMP_REF = "light-git-push-step";
const MERGE_HEAD = ".git/MERGE_HEAD";
const CONFLICTS = ".git/LIGHT_GIT_CONFLICTS";
/** 연결(clone)이 끝나기 전에 앱이 꺼졌는지 표시. 내용은 CloneState */
const CLONING = ".git/LIGHT_GIT_CLONING";
/** pull이 볼트 파일을 다 쓰기 전에 앱이 꺼졌는지 표시. 내용은 PullState */
const PULLING = ".git/LIGHT_GIT_PULLING";
/** 이 플러그인이 만든 저장소 표시 (.git/config) */
const OWNED_KEY = "lightgit.owned";
const RESUME_MSG = "이전 연결이 중간에 멈췄습니다. 설정에서 '원격 저장소 연결'을 다시 실행하세요 (받은 부분부터 이어서 합니다).";
/** git.add 한 번에 넣을 최대 파일 수. index는 묶음마다 한 번만 다시 쓴다 (파일마다 쓰면 노트 2,000개에 index 2,000번) */
const ADD_BATCH = 200;
/** 다른 기기 것으로 덮어쓰면 이 플러그인이 꺼지거나(플러그인 목록) 설정이 바뀌는 경로: 기기에 있으면 항상 기기 것을 둔다 */
const KEEP_LOCAL = [".obsidian/community-plugins.json", ".obsidian/plugins/"];
const DEFAULT_GITIGNORE = [
	".obsidian/workspace.json",
	".obsidian/workspace-mobile.json",
	".trash/",
	".DS_Store",
	"",
].join("\n");

/** fs 메서드 중 백엔드가 직접 쓰는 것만 */
interface Fs {
	readFile(path: string, opts?: { encoding?: string }): Promise<string | Uint8Array>;
	writeFile(path: string, data: string | Uint8Array): Promise<void>;
	unlink(path: string): Promise<void>;
	lstat(path: string): Promise<{ size: number; isDirectory(): boolean }>;
	mkdir(path: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	/** 플러그인 저장소 폴더 (ObsidianFs.gitDir 참고) */
	gitDir: string;
}

/**
 * 다른 도구(obsidian-git, PC git)가 만든 .git은 열지 않고 플러그인 저장소를 여기에 만든다.
 * 그런 .git은 전체 히스토리가 큰 pack 하나라, isomorphic-git이 작업마다 pack을 통째로 메모리에 올린다.
 */
const OWN_GITDIR = ".lightgit";

/** .git/LIGHT_GIT_CLONING 내용 */
interface CloneState {
	/** 볼트가 마지막으로 본 원격 커밋 (기존 .git의 origin/브랜치). 모르면 null */
	base: string | null;
}

/** .git/LIGHT_GIT_PULLING 내용 */
interface PullState {
	/** pull 전 HEAD */
	from: string;
	/** 받은 원격 커밋 */
	theirs: string;
	/** 충돌이 나서 파일을 직접 쓰는 중 (브랜치는 from에 그대로) */
	conflict: boolean;
}

type Blob = { oid: string; mode: number };

/** .git/LIGHT_GIT_CONFLICTS 내용 */
interface ConflictRecord {
	paths: string[];
	/** 한쪽이 삭제한 충돌: 충돌 마커가 없으므로 markResolved로만 해결된다 */
	markerless: string[];
}

/** 트리 비교 결과 + 새 쪽 blob (삭제면 oid 없음) */
interface TreeChange extends FileChange {
	oid?: string;
	mode?: number;
}

const decoder = new TextDecoder();
/** checkout 기본값은 바꿀 파일 전부를 동시에 읽어 써서 1GB면 1GB가 메모리에 올라간다 → 몇 개씩 나눠서 */
const BATCHED = { nonBlocking: true, batchSize: 4 };
const OID_RE = /^[0-9a-f]{40}$/;

/**
 * 모바일(iOS/Android)용 백엔드. 메모리 폭주를 막기 위해
 * - 큰 변경은 chunkBytes 단위로 여러 커밋으로 나누고
 * - push도 커밋 단위로 나눠서 보낸다 (각 push의 packfile이 chunk 크기로 제한됨).
 */
export class IsoBackend implements GitBackend {
	readonly name = "isomorphic-git";

	constructor(
		private fs: Fs,
		private http: git.HttpClient,
		private cfg: () => GitConfig,
		private dir = "/",
		/** 분할 clone 진행 상황 (null = 끝) */
		private onProgress: (msg: string | null) => void = () => {},
	) {}

	/**
	 * 작업 하나(connect/pull/push…) 동안 모든 isomorphic-git 호출이 공유하는 객체 캐시.
	 * 캐시 없이 부르면 호출마다 pack 파일 전체를 다시 읽고 SHA-1 검증까지 한다.
	 * 작업이 끝나면 버린다 (pack을 계속 메모리에 두지 않도록).
	 */
	private cache: object | null = null;
	private depth = 0;
	private unpushedCache: { head: string; tip: string | null; oids: string[] } | null = null;
	/** 이 인스턴스가 지금 pull로 파일을 쓰는 중 (PULLING 표시가 끊긴 흔적이 아님) */
	private pullActive = false;
	private finishing: Promise<void> | null = null;

	private async op<T>(fn: () => Promise<T>): Promise<T> {
		if (this.depth++ === 0) this.cache = {};
		try {
			return await fn();
		} finally {
			if (--this.depth === 0) this.cache = null;
		}
	}

	private get base() {
		// 런타임엔 promise 기반 평면 fs로 인식된다 (isomorphic-git의 isPromiseFs 검사)
		return { fs: this.fs as unknown as git.FsClient, dir: this.dir, cache: this.cache ?? {} };
	}

	private get remote() {
		const c = this.cfg();
		return {
			http: this.http,
			url: c.remoteUrl,
			onAuth: () => (c.token ? { username: c.username || "git", password: c.token } : undefined),
		};
	}

	private get author() {
		const c = this.cfg();
		return { name: c.authorName || "Light Git", email: c.authorEmail || "light-git@localhost" };
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await this.fs.lstat(path);
			return true;
		} catch {
			return false;
		}
	}

	private async headOid(): Promise<string | null> {
		try {
			return await git.resolveRef({ ...this.base, ref: "HEAD" });
		} catch {
			return null;
		}
	}

	async isRepo(): Promise<boolean> {
		return this.exists(".git/config");
	}

	private async doConnect(): Promise<string> {
		const { branch, remoteUrl } = this.cfg();
		if (!remoteUrl) throw new Error("원격 저장소 URL을 설정에서 입력하세요.");
		let base: string | null = null;
		if (this.fs.gitDir === ".git" && (await this.isRepo()) && !(await this.isOwnRepo())) base = await this.useOwnGitDir(branch);
		if (!(await this.isRepo())) {
			await git.init({ ...this.base, defaultBranch: branch });
		}
		await git.setConfig({ ...this.base, path: OWNED_KEY, value: "true" });
		await git.addRemote({ ...this.base, remote: "origin", url: remoteUrl, force: true });
		await git.setConfig({ ...this.base, path: `branch.${branch}.remote`, value: "origin" });
		await git.setConfig({ ...this.base, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });

		const refs = await git.listServerRefs({ ...this.remote, prefix: `refs/heads/${branch}` });
		if (!refs.some((r) => r.ref === `refs/heads/${branch}`)) {
			if (!(await this.exists(".gitignore"))) await this.fs.writeFile(".gitignore", DEFAULT_GITIGNORE);
			return "원격 저장소가 비어 있습니다. 동기화하면 현재 vault가 올라갑니다.";
		}
		// 지난번 연결이 중간에 끊겼으면 이어서 (HEAD는 이미 있어도 볼트 파일은 다 안 써졌을 수 있다)
		const pending = await this.readCloning();
		if (pending) return this.checkoutRemote(pending.base);
		if (await this.headOid()) {
			const conflicts = await this.pull();
			return conflicts.length ? `원격과 병합 중 충돌 ${conflicts.length}건` : "원격과 병합했습니다.";
		}
		return this.checkoutRemote(base);
	}

	/** 이 플러그인이 만든 .git인가 */
	private async isOwnRepo(): Promise<boolean> {
		const owned = await git.getConfig({ ...this.base, path: OWNED_KEY }).catch(() => undefined);
		if (owned === true || owned === "true") return true;
		// 0.1.4까지는 표시를 남기지 않았다. 이 플러그인의 clone은 항상 shallow이고, obsidian-git 기본 clone은 전체 히스토리다.
		return this.exists(".git/shallow");
	}

	/**
	 * 기존 .git은 그대로 두고 플러그인 저장소를 .lightgit에 만든다. 양쪽 git 모두 .lightgit을 무시하게 한다.
	 * 기존 저장소가 마지막으로 본 원격 커밋을 돌려준다 (볼트 파일이 '안 바뀐 옛 버전'인지 '이 기기에서 고친 것'인지 가리는 기준).
	 */
	private async useOwnGitDir(branch: string): Promise<string | null> {
		const base = await this.readForeignRemoteTip(branch);
		await this.ignoreIn(".git/info", OWN_GITDIR + "/");
		this.fs.gitDir = OWN_GITDIR;
		if (!(await this.exists(".git"))) await this.fs.mkdir(".git"); // = .lightgit
		await this.ignoreIn(".git/info", OWN_GITDIR + "/"); // 이제 .lightgit/info/exclude
		return base;
	}

	/** 기존 .git의 refs/remotes/origin/<branch>. pack을 열지 않도록 ref 파일만 직접 읽는다. */
	private async readForeignRemoteTip(branch: string): Promise<string | null> {
		const ref = `refs/remotes/origin/${branch}`;
		const text = (p: string) => this.fs.readFile(p, { encoding: "utf8" }).then(String, () => "");
		const loose = (await text(`.git/${ref}`)).trim();
		if (OID_RE.test(loose)) return loose;
		for (const line of (await text(".git/packed-refs")).split("\n")) {
			const [oid, name] = line.trim().split(" ");
			if (name === ref && OID_RE.test(oid)) return oid;
		}
		return null;
	}

	private async readCloning(): Promise<CloneState | null> {
		try {
			const st = JSON.parse(String(await this.fs.readFile(CLONING, { encoding: "utf8" })));
			return { base: typeof st?.base === "string" && OID_RE.test(st.base) ? st.base : null };
		} catch {
			return null;
		}
	}

	private async ignoreIn(infoDir: string, line: string) {
		if (!(await this.exists(infoDir))) await this.fs.mkdir(infoDir);
		const file = `${infoDir}/exclude`;
		const cur = await this.fs.readFile(file, { encoding: "utf8" }).then(String, () => "");
		if (cur.split("\n").some((l) => l.trim() === line)) return;
		await this.fs.writeFile(file, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");
	}

	private fetchOptions(reuse?: PartialFetchOptions["reuse"]): PartialFetchOptions {
		return { fs: this.fs, dir: this.dir, ...this.remote, branch: this.cfg().branch, onProgress: this.onProgress, reuse, cache: this.cache ?? undefined };
	}

	/** 큰 저장소를 메모리 초과 없이 받는다 (partialFetch 참고). 서버가 지원하지 않으면 null. */
	private partialFetch(reuse?: PartialFetchOptions["reuse"]): Promise<string | null> {
		return partialFetch(this.fetchOptions(reuse));
	}

	/**
	 * 볼트 파일들을 index에 넣는다 (내용 blob도 저장됨). 파일마다 index를 다시 쓰지 않도록 묶어서,
	 * 한 묶음에 동시에 읽는 양은 chunkBytes 이하로. 넣은 경로는 added에 기록.
	 */
	private async addInBatches(files: { path: string; size: number }[], added: Set<string>) {
		const limit = this.cfg().chunkBytes;
		const todo = files.filter((f) => !added.has(f.path));
		let batch: string[] = [];
		let bytes = 0;
		let done = 0;
		const flush = async () => {
			if (!batch.length) return;
			await git.add({ ...this.base, filepath: batch, force: true });
			for (const p of batch) added.add(p);
			done += batch.length;
			this.onProgress(`Git: 볼트에 있는 파일 확인 중 ${done}/${todo.length}개`);
			batch = [];
			bytes = 0;
		};
		for (const f of todo) {
			if (batch.length && (batch.length >= ADD_BATCH || bytes + f.size > limit)) await flush();
			batch.push(f.path);
			bytes += f.size;
		}
		await flush();
	}

	/** 경로 중 볼트에 파일로 있는 것과 그 크기 */
	private async localFiles(paths: Iterable<string>, total: number): Promise<Map<string, number>> {
		const out = new Map<string, number>();
		let n = 0;
		for (const p of paths) {
			const st = await this.fs.lstat(p).catch(() => null);
			if (st && !st.isDirectory()) out.set(p, st.size);
			if (++n % 500 === 0) this.onProgress(`Git: 볼트 파일 찾는 중 ${n}/${total}개`);
		}
		return out;
	}

	/** partialFetch reuse: 원격의 큰 파일과 내용이 같은 볼트 파일로 blob을 채운다 (다시 받지 않음) */
	private async adoptLocal(items: { path: string; oid: string }[], added: Set<string>): Promise<Set<string>> {
		const local = await this.localFiles(
			items.map((i) => i.path),
			items.length,
		);
		await this.addInBatches([...local].map(([path, size]) => ({ path, size })), added);
		const staged = await this.stagedBlobs([...local.keys()]);
		return new Set(items.filter((i) => staged.get(i.path)?.oid === i.oid).map((i) => i.oid));
	}

	/** 커밋 트리의 파일 경로 → blob */
	private async treeBlobs(commit: string): Promise<Map<string, Blob>> {
		const out = new Map<string, Blob>();
		await git.walk({
			...this.base,
			trees: [git.TREE({ ref: commit })],
			map: async (path, [e]) => {
				if (path !== "." && e && (await e.type()) === "blob") out.set(path, { oid: await e.oid(), mode: await e.mode() });
				return true;
			},
		});
		return out;
	}

	/** 기준 커밋의 파일 목록 (트리만 받아서). 원격에서 못 받으면 null */
	private async baseBlobs(base: string): Promise<Map<string, Blob> | null> {
		if (!(await fetchTreesOnly(this.fetchOptions(), base))) return null;
		try {
			return await this.treeBlobs(base);
		} catch (e) {
			console.warn("[light-git] 기준 커밋 트리를 읽지 못했습니다", e);
			return null;
		}
	}

	/**
	 * 로컬 커밋이 없을 때: 원격 브랜치를 가져와 working tree에 반영 (clone과 동일).
	 * 볼트에 이미 파일이 있으면(기존 볼트) reconcile 규칙으로 하나씩 판정한다. 이 기기에서 고친 내용은 지우지 않는다.
	 * 도중에 앱이 꺼지면 CLONING 표시가 남아 다음 연결이 이어서 한다.
	 */
	private async checkoutRemote(base: string | null): Promise<string> {
		const { branch } = this.cfg();
		await this.fs.writeFile(CLONING, JSON.stringify({ base } satisfies CloneState));
		try {
			const added = new Set<string>();
			const tip =
				(await this.partialFetch((items) => this.adoptLocal(items, added))) ||
				(await git.fetch({ ...this.base, ...this.remote, ref: branch, singleBranch: true, tags: false, depth: 1 })).fetchHead;
			if (!tip) throw new Error(`원격 브랜치 ${branch}를 받지 못했습니다.`);
			const baseMap = base ? (base === tip ? await this.treeBlobs(tip) : await this.baseBlobs(base)) : null;
			await git.writeRef({ ...this.base, ref: `refs/heads/${branch}`, value: tip, force: true });
			const msg = await this.reconcile(tip, baseMap, added, !!base);
			await this.fs.unlink(CLONING);
			return msg;
		} finally {
			this.onProgress(null);
		}
	}

	/**
	 * 원격 tip(T)과 볼트 파일(L)을 맞춘다. B = 볼트가 마지막으로 본 원격 상태 (모르면 null).
	 *  - L == T: 그대로 (다시 받지 않음)
	 *  - L 없음: 원격 것을 쓴다. 단 B == T면 이 기기에서 지운 것 → '삭제'로 남긴다
	 *  - 플러그인 목록/플러그인 폴더: 항상 기기 것 (원격 것을 쓰면 이 플러그인이 꺼질 수 있음)
	 *  - L == B: 이 기기는 안 바꿨고 원격만 바뀜 → 원격 것 (B를 모르면 .obsidian 설정만 이렇게: Obsidian이 만든 기본값)
	 *  - T == B: 이 기기에서만 바뀜 → 볼트 파일 유지, '변경됨'으로 표시 (다음 동기화 때 올라감)
	 *  - 그 외(양쪽 다 바뀜, 또는 B를 몰라 어느 쪽이 최신인지 모름): 원격 것을 쓰고 볼트 파일은 '(충돌 사본)'으로 보관
	 *    → 예전 파일로 원격 최신본을 조용히 덮어쓰는 일이 없다
	 *  - B에 있고 T에 없음(원격에서 삭제) + L == B: 볼트에서도 삭제
	 */
	private async reconcile(tip: string, baseMap: Map<string, Blob> | null, added: Set<string>, hadBase: boolean): Promise<string> {
		const { branch } = this.cfg();
		const tipMap = await this.treeBlobs(tip);
		const local = await this.localFiles(tipMap.keys(), tipMap.size);
		await this.addInBatches([...local].map(([path, size]) => ({ path, size })), added);
		const staged = await this.stagedBlobs([...local.keys()]);

		const take: string[] = [];
		const keepIndex: string[] = [];
		const copies: string[] = [];
		let fresh = 0;
		let kept = 0;
		for (const [path, t] of tipMap) {
			const l = local.has(path) ? staged.get(path)?.oid : undefined;
			if (l === t.oid) continue;
			const b = baseMap?.get(path)?.oid;
			if (l === undefined) {
				if (baseMap && b === t.oid) keepIndex.push(path);
				else take.push(path);
				continue;
			}
			if (KEEP_LOCAL.some((k) => path === k || path.startsWith(k))) {
				keepIndex.push(path);
				continue;
			}
			if (baseMap ? l === b : path.startsWith(".obsidian/")) {
				take.push(path);
				fresh++;
			} else if (baseMap && b === t.oid) {
				keepIndex.push(path);
				kept++;
			} else {
				copies.push(path);
				take.push(path);
			}
		}

		const removed: string[] = [];
		if (baseMap) {
			for (const [path, b] of baseMap) {
				if (tipMap.has(path) || KEEP_LOCAL.some((k) => path === k || path.startsWith(k))) continue;
				const data = await this.fs.readFile(path).catch(() => null);
				if (data instanceof Uint8Array && (await git.hashBlob({ object: data })).oid === b.oid) {
					await this.fs.unlink(path);
					removed.push(path);
				}
			}
		}

		const stamp = conflictStamp();
		for (const path of copies) {
			const data = await this.fs.readFile(path);
			await this.fs.writeFile(await this.freePath(conflictCopyPath(path, stamp)), data);
		}
		for (const path of keepIndex) {
			const t = tipMap.get(path)!;
			await git.updateIndex({ ...this.base, filepath: path, oid: t.oid, mode: t.mode, add: true, force: true });
		}
		if (take.length) {
			this.onProgress(`Git: 볼트에 파일 쓰는 중… (${take.length}개)`);
			await git.checkout({ ...this.base, ref: branch, filepaths: take, force: true, ...BATCHED });
		}

		if (!local.size) return "원격 저장소를 받아왔습니다.";
		const parts = [`원격 저장소를 받아왔습니다. 볼트에 있던 파일 ${local.size}개 확인.`];
		if (fresh) parts.push(`원격 최신본으로 갱신 ${fresh}개`);
		if (kept) parts.push(`이 기기에서 바뀐 ${kept}개는 '변경'으로 남김 (동기화하면 올라감)`);
		if (copies.length) parts.push(`어느 쪽이 최신인지 알 수 없는 ${copies.length}개는 원격 내용으로 쓰고, 볼트에 있던 내용은 '(충돌 사본)' 파일로 보관`);
		if (removed.length) parts.push(`원격에서 삭제된 ${removed.length}개 삭제`);
		if (!hadBase && copies.length) parts.push("(이전 Git 기록이 없어 비교 기준을 몰랐습니다)");
		return parts.join("\n");
	}

	/** 이미 있으면 " 2", " 3"…을 붙인 경로 */
	private async freePath(path: string): Promise<string> {
		if (!(await this.exists(path))) return path;
		const dot = path.lastIndexOf(".");
		const slash = path.lastIndexOf("/");
		const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
		for (let i = 2; ; i++) if (!(await this.exists(`${stem} ${i}${ext}`))) return `${stem} ${i}${ext}`;
	}

	private async doChanges(): Promise<WorkChange[]> {
		await this.finishPull();
		const matrix = await git.statusMatrix({ ...this.base });
		const out: WorkChange[] = [];
		// statusMatrix 값: head/workdir 0=없음 1=HEAD와 같음 2=다름, stage 0=없음 1=HEAD와 같음 2=작업 파일과 같음 3=둘 다와 다름
		for (const [path, head, workdir, stage] of matrix) {
			const staged = head === 0 ? stage !== 0 : stage !== 1;
			const unstaged = stage === 2 ? false : stage === 3 ? true : stage === 1 ? workdir !== 1 : workdir !== 0;
			if (!staged && !unstaged) continue;
			out.push({ path, type: head === 0 ? "added" : workdir === 0 ? "deleted" : "modified", staged, unstaged });
		}
		return this.joinNormalizedNames(out);
	}

	/**
	 * iOS/macOS 파일 시스템은 한글 이름의 조합 방식(NFC/NFD)이 달라도 같은 파일로 찾지만, 폴더 목록은 저장된 이름 그대로 돌려준다.
	 * 그러면 커밋에 있는 이름과 달라 '삭제 + 추가'로 보이므로 한 파일로 되돌린다.
	 * 커밋에 있는 이름으로 파일을 찾을 수 있을 때만 합치므로, 두 이름이 정말 다른 파일인 시스템에서는 그대로 둔다.
	 */
	private async joinNormalizedNames(changes: WorkChange[]): Promise<WorkChange[]> {
		const nfc = (p: string) => p.normalize("NFC");
		const added = changes.filter((c) => c.type === "added" && nfc(c.path) !== c.path.normalize("NFD"));
		if (!added.length) return changes;
		const drop = new Set<WorkChange>();
		const out: WorkChange[] = [];
		for (const c of changes) {
			const twin = c.type === "deleted" ? added.find((a) => a.path !== c.path && nfc(a.path) === nfc(c.path)) : undefined;
			if (!twin || !(await this.exists(c.path))) {
				out.push(c);
				continue;
			}
			drop.add(twin);
			const data = await this.fs.readFile(c.path);
			const inHead = await this.readBlobAt("HEAD", c.path);
			const same = !!inHead && (await git.hashBlob({ object: data })).oid === (await git.hashBlob({ object: inHead })).oid;
			if (!same || c.staged) out.push({ path: c.path, type: "modified", staged: c.staged, unstaged: !c.staged });
		}
		return out.filter((c) => !drop.has(c));
	}

	private async doStage(paths: string[]): Promise<void> {
		const adds: string[] = [];
		for (const p of paths) {
			if (await this.exists(p)) adds.push(p);
			else await git.remove({ ...this.base, filepath: p });
		}
		if (adds.length) await git.add({ ...this.base, filepath: adds });
	}

	private async doUnstage(paths: string[]): Promise<void> {
		const hasHead = !!(await this.headOid());
		for (const p of paths) {
			if (hasHead) await git.resetIndex({ ...this.base, filepath: p });
			else await git.remove({ ...this.base, filepath: p }); // 첫 커밋 전: index에서 빼기만
		}
	}

	private async readMergeHead(): Promise<string | null> {
		try {
			return String(await this.fs.readFile(MERGE_HEAD, { encoding: "utf8" })).trim() || null;
		} catch {
			return null;
		}
	}

	async isMerging(): Promise<boolean> {
		await this.finishPull();
		return !!(await this.readMergeHead());
	}

	async conflicts(): Promise<string[]> {
		await this.finishPull();
		if (!(await this.readMergeHead())) return [];
		const rec = await this.readConflictRecord();
		const unresolved: string[] = [];
		for (const p of rec.paths) {
			if (rec.markerless.includes(p)) {
				unresolved.push(p);
				continue;
			}
			try {
				const text = String(await this.fs.readFile(p, { encoding: "utf8" }));
				if (/^<<<<<<< /m.test(text) && /^>>>>>>> /m.test(text)) unresolved.push(p);
			} catch {
				// 삭제로 해결한 경우
			}
		}
		return unresolved;
	}

	private async readConflictRecord(): Promise<ConflictRecord> {
		try {
			return JSON.parse(String(await this.fs.readFile(CONFLICTS, { encoding: "utf8" })));
		} catch {
			return { paths: [], markerless: [] };
		}
	}

	async markResolved(path: string): Promise<void> {
		const rec = await this.readConflictRecord();
		rec.paths = rec.paths.filter((p) => p !== path);
		rec.markerless = rec.markerless.filter((p) => p !== path);
		await this.fs.writeFile(CONFLICTS, JSON.stringify(rec));
	}

	private async resolveRev(rev: string): Promise<string | null> {
		if (OID_RE.test(rev)) return rev;
		if (rev === "MERGE_HEAD") return this.readMergeHead();
		try {
			return await git.resolveRef({ ...this.base, ref: rev });
		} catch {
			return null;
		}
	}

	private async readBlobAt(rev: string, path: string): Promise<Uint8Array | null> {
		const oid = await this.resolveRev(rev);
		if (!oid) return null;
		try {
			return (await git.readBlob({ ...this.base, oid, filepath: path })).blob;
		} catch {
			return null;
		}
	}

	private async doReadAt(rev: string, path: string): Promise<string | null> {
		const blob = await this.readBlobAt(rev, path);
		return blob ? decoder.decode(blob) : null;
	}

	private async doConflictVersions(path: string): Promise<ConflictVersions> {
		const head = await this.headOid();
		const theirs = await this.readMergeHead();
		let base: string | null = null;
		if (head && theirs) {
			try {
				base = (await git.findMergeBase({ ...this.base, oids: [head, theirs] }))[0] ?? null;
			} catch {
				base = null;
			}
		}
		return {
			base: base ? await this.readAt(base, path) : null,
			ours: head ? await this.readAt(head, path) : null,
			theirs: theirs ? await this.readAt(theirs, path) : null,
		};
	}

	private async mkdirp(dir: string) {
		const parts = dir.split("/").filter(Boolean);
		for (let i = 1; i <= parts.length; i++) {
			try {
				await this.fs.mkdir(parts.slice(0, i).join("/"));
			} catch {
				// 이미 있음
			}
		}
	}

	private async doDiscard(path: string): Promise<void> {
		await this.unstage([path]);
		const blob = await this.readBlobAt("HEAD", path);
		if (blob) {
			const slash = path.lastIndexOf("/");
			if (slash > 0) await this.mkdirp(path.slice(0, slash));
			await this.fs.writeFile(path, blob);
		} else if (await this.exists(path)) {
			await this.fs.unlink(path);
		}
	}

	private async doLog(limit: number): Promise<CommitInfo[]> {
		if (!(await this.headOid())) return [];
		const entries = await git.log({ ...this.base, ref: "HEAD", depth: limit });
		return entries.map((e) => ({
			oid: e.oid,
			parent: e.commit.parent[0],
			parents: e.commit.parent,
			message: e.commit.message.trim(),
			author: e.commit.author.name,
			timestamp: e.commit.author.timestamp,
		}));
	}

	/** 커밋 a → b 사이에 바뀐 파일 (a가 null이면 b 전체가 '추가'). oid/mode는 b 쪽 blob. */
	private async diffTrees(a: string | null, b: string): Promise<TreeChange[]> {
		const refs = a ? [a, b] : [b];
		const out: TreeChange[] = [];
		await git.walk({
			...this.base,
			trees: refs.map((ref) => git.TREE({ ref })),
			map: async (filepath, entries) => {
				if (filepath === ".") return true;
				const [x, y] = a ? entries : [null, entries[0]];
				const [tx, ty] = [await x?.type(), await y?.type()];
				const [ox, oy] = [await x?.oid(), await y?.oid()];
				if (ox && ox === oy) return null; // 같은 트리/파일 → 하위 탐색 생략
				if (tx === "tree" || ty === "tree") return true;
				const blob = y && ty === "blob" ? { oid: oy, mode: await y.mode() } : {};
				if (!x || tx !== "blob") out.push({ path: filepath, type: "added", ...blob });
				else if (!y || ty !== "blob") out.push({ path: filepath, type: "deleted" });
				else out.push({ path: filepath, type: "modified", ...blob });
				return true;
			},
		});
		return out;
	}

	private async doCommitFiles(oid: string): Promise<FileChange[]> {
		const { commit } = await git.readCommit({ ...this.base, oid });
		const parent = commit.parent[0];
		let files: TreeChange[] | null = null;
		if (parent) {
			try {
				files = await this.diffTrees(parent, oid);
			} catch {
				// shallow 경계: 부모 객체가 없음 → 전체를 '추가'로 표시
			}
		}
		files ??= await this.diffTrees(null, oid);
		return files.map(({ path, type }) => ({ path, type }));
	}

	private async clearMergeState() {
		for (const p of [MERGE_HEAD, CONFLICTS]) {
			try {
				await this.fs.unlink(p);
			} catch {
				// 없으면 무시
			}
		}
	}

	/** 변경 목록을 chunkBytes 이하 묶음으로 나눈다. chunk보다 큰 파일은 단독 묶음. 크기는 작업 파일 기준(근사). */
	private async chunk<T extends FileChange>(changes: T[]): Promise<T[][]> {
		const limit = this.cfg().chunkBytes;
		const groups: T[][] = [];
		let cur: T[] = [];
		let size = 0;
		for (const c of changes) {
			const s = c.type === "deleted" ? 0 : await this.fs.lstat(c.path).then((st) => st.size, () => 0);
			if (cur.length && size + s > limit) {
				groups.push(cur);
				cur = [];
				size = 0;
			}
			cur.push(c);
			size += s;
		}
		if (cur.length) groups.push(cur);
		return groups;
	}

	/** 스테이징된 파일의 index 내용(blob oid/mode). 없으면 삭제가 스테이징된 것. */
	private async stagedBlobs(paths: string[]): Promise<Map<string, { oid: string; mode: number }>> {
		const want = new Set(paths);
		const out = new Map<string, { oid: string; mode: number }>();
		await git.walk({
			...this.base,
			trees: [git.STAGE()],
			map: async (filepath, [e]) => {
				if (e && want.has(filepath) && (await e.type()) === "blob") out.set(filepath, { oid: (await e.oid())!, mode: await e.mode() });
				return true;
			},
		});
		return out;
	}

	private async doCommit(message: CommitMessage, stagedOnly = false): Promise<number> {
		if (await this.readCloning()) throw new Error(RESUME_MSG);
		await this.finishPull();
		const mergeHead = await this.readMergeHead();
		if (mergeHead) {
			const unresolved = await this.conflicts();
			if (unresolved.length) throw new Error(`해결되지 않은 충돌 ${unresolved.length}건이 있습니다.`);
			const head = await this.headOid();
			const all = await this.changes();
			const pending = all.filter((c) => !isNewConflictCopy(c));
			await this.unstage(all.filter((c) => c.staged && isNewConflictCopy(c)).map((c) => c.path));
			await this.stage(pending.map((c) => c.path));
			await git.commit({ ...this.base, message: messageText(message, pending.length), author: this.author, parent: [head!, mergeHead] });
			await this.clearMergeState();
			return 1;
		}

		const all = await this.changes();
		const changes = all.filter((c) => !isNewConflictCopy(c) && (!stagedOnly || c.staged));
		if (!changes.length) return 0;
		const text = messageText(message, changes.length);
		// 묶음마다 index를 HEAD + 그 묶음만 담은 상태로 만들어 커밋한다.
		// stagedOnly면 스테이징된 내용(일부만 스테이징한 파일 포함)을 보존해 다시 넣고, 아니면 작업 파일을 넣는다.
		const blobs = stagedOnly ? await this.stagedBlobs(changes.map((c) => c.path)) : null;
		await this.unstage(all.filter((c) => c.staged).map((c) => c.path));
		const groups = await this.chunk(changes);
		for (let i = 0; i < groups.length; i++) {
			if (blobs) {
				for (const c of groups[i]) {
					const b = blobs.get(c.path);
					if (b) await git.updateIndex({ ...this.base, filepath: c.path, oid: b.oid, mode: b.mode, add: true });
					else await git.remove({ ...this.base, filepath: c.path });
				}
			} else {
				await this.stage(groups[i].map((c) => c.path));
			}
			const msg = groups.length > 1 ? `${text} (${i + 1}/${groups.length})` : text;
			await git.commit({ ...this.base, message: msg, author: this.author });
		}
		return groups.length;
	}

	private async doPull(): Promise<string[]> {
		const { branch, remoteUrl } = this.cfg();
		if (!remoteUrl) return [];
		if (await this.readCloning()) throw new Error(RESUME_MSG);
		await this.finishPull();
		if (await this.readMergeHead()) return this.conflicts();
		const head = await this.headOid();
		if (!head) {
			await this.checkoutRemote(null);
			return [];
		}
		// isomorphic-git fetch는 로컬 커밋 뒤엔 원격이 공통 지점을 몰라 트리·히스토리 전체를 보낸다 → 앱이 꺼지던 원인
		let theirs: string | null | undefined;
		try {
			theirs = (await this.partialFetch()) ?? (await git.fetch({ ...this.base, ...this.remote, ref: branch, singleBranch: true, tags: false })).fetchHead;
		} finally {
			this.onProgress(null);
		}
		if (!theirs || theirs === head) return [];
		// 로컬이 앞서 있기만 하면(원격 새 커밋 없음) merge/checkout은 할 일이 없다 — checkout은 vault 전체를 훑으므로 비싸다
		if (await git.isDescendent({ ...this.base, oid: head, ancestor: theirs, depth: -1 }).catch(() => false)) return [];
		await this.assertNoOverlap(head, theirs);
		// git.merge는 브랜치를 먼저 옮기고 파일은 그 뒤에 쓴다. 그 사이에 꺼지면 아직 안 쓴 옛 파일이 '내 변경'으로 보여 다음 동기화가 원격 변경을 되돌린다.
		await this.fs.writeFile(PULLING, JSON.stringify({ from: head, theirs, conflict: false } satisfies PullState));
		this.pullActive = true;
		try {
			let conflicts: string[] = [];
			try {
				// abortOnConflict:false는 충돌 시 결과 트리의 '모든' 파일을 폴더 단위로 동시에 다시 써서 큰 볼트에선 메모리가 터진다
				await git.merge({ ...this.base, ours: branch, theirs, author: this.author, abortOnConflict: true, allowUnrelatedHistories: true, message: this.mergeMessage() });
				await git.checkout({ ...this.base, ref: branch, ...BATCHED });
			} catch (e) {
				if (!(e instanceof git.Errors.MergeConflictError)) throw e;
				await this.fs.writeFile(PULLING, JSON.stringify({ from: head, theirs, conflict: true } satisfies PullState));
				conflicts = await this.applyConflictedMerge(head, theirs, false);
			}
			await this.fs.unlink(PULLING);
			return conflicts;
		} finally {
			this.pullActive = false;
		}
	}

	private mergeMessage(): string {
		return `Merge remote-tracking branch 'origin/${this.cfg().branch}'`;
	}

	/** 충돌 merge를 파일에 쓰고 머지 중 상태를 남긴다 (충돌이 없었으면 커밋까지). 남은 충돌 파일을 돌려준다. */
	private async applyConflictedMerge(head: string, theirs: string, resuming: boolean): Promise<string[]> {
		const rec = await this.writeConflictedMerge(head, theirs, resuming);
		if (!rec.paths.length) {
			await git.commit({ ...this.base, message: this.mergeMessage(), author: this.author, parent: [head, theirs] });
			return [];
		}
		await this.fs.writeFile(CONFLICTS, JSON.stringify(rec));
		await this.fs.writeFile(MERGE_HEAD, theirs + "\n");
		return rec.paths;
	}

	/** 이전 pull이 파일을 다 쓰기 전에 멈췄으면 끝까지 맞춘다. 진행 중인 pull은 건드리지 않고, 동시에 불려도 한 번만 한다. */
	private finishPull(): Promise<void> {
		if (this.pullActive) return Promise.resolve();
		return (this.finishing ??= this.op(() => this.doFinishPull()).finally(() => {
			this.finishing = null;
		}));
	}

	private async doFinishPull(): Promise<void> {
		let st: PullState;
		try {
			st = JSON.parse(String(await this.fs.readFile(PULLING, { encoding: "utf8" })));
		} catch {
			return; // 표시 없음 (또는 쓰다가 꺼짐: 이 경우 아직 아무것도 바꾸지 않았다)
		}
		if (!(await this.readMergeHead())) {
			const head = await this.headOid();
			if (head && head !== st.from) {
				const before = await this.treeBlobs(st.from);
				for (const c of await this.diffTrees(st.from, head)) {
					await this.keepUnknownEdit(c.path, [before.get(c.path)?.oid, c.oid]);
					await this.applyBlob(c.path, c.oid ? { oid: c.oid, mode: c.mode! } : undefined);
				}
			} else if (head && st.conflict) {
				await this.applyConflictedMerge(head, st.theirs, true);
			}
		}
		await this.fs.unlink(PULLING);
	}

	/** 볼트 파일이 known 중 어느 내용도 아니면 (앱이 꺼진 뒤 사용자가 고쳤거나 쓰다 끊김) 덮어쓰기 전에 '(충돌 사본)'으로 보관한다 */
	private async keepUnknownEdit(path: string, known: (string | undefined)[]) {
		const data = await this.fs.readFile(path).catch(() => null);
		if (!(data instanceof Uint8Array)) return;
		if (known.includes((await git.hashBlob({ object: data })).oid)) return;
		await this.fs.writeFile(await this.freePath(conflictCopyPath(path, conflictStamp())), data);
	}

	/**
	 * 충돌이 있는 merge를 작업 파일과 index에 반영한다. 원격이 바꾼 파일만 하나씩:
	 * 원격만 바꿈 → 원격 것, 양쪽이 겹치지 않게 바꿈 → 자동 병합, 겹침 → 충돌 마커, 한쪽 삭제·바이너리 → 마커 없는 충돌(내 것 유지).
	 * resuming: 끊긴 merge를 다시 쓰는 중이라 그사이 사용자가 고친 내용은 사본으로 보관한다.
	 */
	private async writeConflictedMerge(head: string, theirs: string, resuming: boolean): Promise<ConflictRecord> {
		let base: string | null = null;
		try {
			base = (await git.findMergeBase({ ...this.base, oids: [head, theirs] }))[0] ?? null;
		} catch {
			base = null;
		}
		const rec: ConflictRecord = { paths: [], markerless: [] };
		for (const { path, base: b, ours: o, theirs: t } of await this.threeWay(base, head, theirs)) {
			if (o?.oid === t?.oid) continue;
			if (o?.oid === b?.oid) {
				if (resuming) await this.keepUnknownEdit(path, [o?.oid, t?.oid]);
				await this.applyBlob(path, t);
				continue;
			}
			const texts = o && t ? [b ? await this.blobText(b.oid) : "", await this.blobText(o.oid), await this.blobText(t.oid)] : null;
			if (!texts || texts.includes(null)) {
				rec.paths.push(path);
				rec.markerless.push(path);
				continue;
			}
			const regions = buildRegions(texts[0]!, texts[1]!, texts[2]!);
			applyNonConflicting(regions);
			const conflicted = regions.some((r) => r.kind === "conflict");
			const merged = conflicted ? conflictMarkerText(regions) : mergedText(regions);
			if (resuming) await this.keepUnknownEdit(path, [o?.oid, (await git.hashBlob({ object: new TextEncoder().encode(merged) })).oid]);
			await this.fs.writeFile(path, merged);
			if (conflicted) rec.paths.push(path);
			else await git.add({ ...this.base, filepath: path });
		}
		return rec;
	}

	/** base(없으면 생략)/ours/theirs 트리에서 theirs가 base와 다르고 ours와도 다른 파일들. 내용은 읽지 않는다. */
	private async threeWay(base: string | null, ours: string, theirs: string) {
		type Blob = { oid: string; mode: number } | undefined;
		const out: { path: string; base: Blob; ours: Blob; theirs: Blob }[] = [];
		const blob = async (e: git.WalkerEntry | null): Promise<Blob> => (e && (await e.type()) === "blob" ? { oid: await e.oid(), mode: await e.mode() } : undefined);
		await git.walk({
			...this.base,
			trees: (base ? [base, ours, theirs] : [ours, theirs]).map((ref) => git.TREE({ ref })),
			map: async (filepath, entries) => {
				if (filepath === ".") return true;
				const [b, o, t] = base ? entries : [null, ...entries];
				const ot = await t?.oid();
				if ((base && (await b?.oid()) === ot) || (await o?.oid()) === ot) return null; // 원격이 안 바꿨거나 양쪽이 같음
				if ([await b?.type(), await o?.type(), await t?.type()].includes("tree")) return true;
				out.push({ path: filepath, base: await blob(b), ours: await blob(o), theirs: await blob(t) });
				return true;
			},
		});
		return out;
	}

	/** 작업 파일과 index를 blob으로 (없으면 삭제) */
	private async applyBlob(path: string, blob: { oid: string; mode: number } | undefined) {
		if (!blob) {
			if (await this.exists(path)) await this.fs.unlink(path);
			await git.remove({ ...this.base, filepath: path });
			return;
		}
		const slash = path.lastIndexOf("/");
		if (slash > 0) await this.mkdirp(path.slice(0, slash));
		await this.fs.writeFile(path, (await git.readBlob({ ...this.base, oid: blob.oid })).blob);
		await git.updateIndex({ ...this.base, filepath: path, oid: blob.oid, mode: blob.mode, add: true });
	}

	/** 텍스트면 내용, 바이너리(NUL 포함)면 null */
	private async blobText(oid: string): Promise<string | null> {
		const { blob } = await git.readBlob({ ...this.base, oid });
		return blob.subarray(0, 8000).includes(0) ? null : decoder.decode(blob);
	}

	/**
	 * 커밋 안 한 변경(스테이징 안 한 파일, 동기화 중 편집 등)이 원격 변경과 같은 파일이면 pull을 막는다.
	 * isomorphic-git의 merge/checkout은 그런 파일을 덮어쓰거나, 브랜치만 옮기고 작업 파일은 옛 상태로 남길 수 있다.
	 */
	private async assertNoOverlap(head: string, theirs: string) {
		const dirty = new Set((await this.changes()).map((c) => c.path));
		if (!dirty.size) return;
		let base: string | null = null;
		try {
			base = (await git.findMergeBase({ ...this.base, oids: [head, theirs] }))[0] ?? null;
		} catch {
			base = null;
		}
		let incoming: FileChange[];
		try {
			incoming = await this.diffTrees(base ?? head, theirs);
		} catch {
			incoming = await this.diffTrees(head, theirs); // base가 shallow 경계 밖
		}
		const overlap = incoming.map((c) => c.path).filter((p) => dirty.has(p));
		if (overlap.length) {
			throw new Error(`커밋하지 않은 변경이 원격에서 바뀐 파일과 겹칩니다. 먼저 커밋하거나 되돌리세요: ${overlap.slice(0, 5).join(", ")}${overlap.length > 5 ? ` 외 ${overlap.length - 5}개` : ""}`);
		}
	}

	/** base 트리에 경로별 변경(oid 없음 = 삭제)을 적용한 새 트리. 비면 null. */
	private async applyTree(base: string | null, changes: Map<string, TreeChange>): Promise<string | null> {
		const entries = new Map<string, git.TreeEntry>();
		if (base) for (const e of (await git.readTree({ ...this.base, oid: base })).tree) entries.set(e.path, e);
		const sub = new Map<string, Map<string, TreeChange>>();
		for (const [p, c] of changes) {
			const i = p.indexOf("/");
			if (i < 0) {
				if (c.oid) entries.set(p, { path: p, oid: c.oid, mode: (c.mode ?? 0o100644).toString(8), type: "blob" });
				else entries.delete(p);
				continue;
			}
			const dir = p.slice(0, i);
			if (!sub.has(dir)) sub.set(dir, new Map());
			sub.get(dir)!.set(p.slice(i + 1), c);
		}
		for (const [dir, m] of sub) {
			const cur = entries.get(dir);
			const oid = await this.applyTree(cur?.type === "tree" ? cur.oid : null, m);
			if (oid) entries.set(dir, { path: dir, oid, mode: "040000", type: "tree" });
			else entries.delete(dir);
		}
		return entries.size ? git.writeTree({ ...this.base, tree: [...entries.values()] }) : null;
	}

	/**
	 * 원격과 갈라진 경우(로컬 머지 커밋이 있음): 현재 HEAD의 결과물을 원격 tip 위에
	 * chunk 단위 커밋으로 다시 쌓는다 (rebase와 같은 효과, 로컬에만 있던 커밋은 대체됨).
	 * 머지 커밋을 그대로 올리면 fast-forward 분할이 불가능하고 한 번에 전부 전송되기 때문.
	 */
	private async linearize(head: string, remoteTip: string, chain: string[]): Promise<string[]> {
		const { branch } = this.cfg();
		const read = async (oid: string) => (await git.readCommit({ ...this.base, oid })).commit;
		const headTree = (await read(head)).tree;
		let tree = (await read(remoteTip)).tree;
		const groups = await this.chunk(await this.diffTrees(remoteTip, head));

		const messages: string[] = [];
		for (const oid of chain) {
			const c = await read(oid);
			if (c.parent.length !== 1) continue;
			const m = c.message.trim().replace(/ \(\d+\/\d+\)$/, "");
			if (!messages.includes(m)) messages.push(m);
		}
		const message = messages.join("\n") || `Merge remote-tracking branch 'origin/${branch}'`;

		const out: string[] = [];
		let parent = remoteTip;
		for (let i = 0; i < groups.length; i++) {
			const last = i === groups.length - 1;
			// 마지막 커밋은 HEAD 트리를 그대로 써서 결과가 정확히 같음을 보장
			tree = last ? headTree : ((await this.applyTree(tree, new Map(groups[i].map((c) => [c.path, c])))) ?? (await git.writeTree({ ...this.base, tree: [] })));
			const msg = groups.length > 1 ? `${message} (${i + 1}/${groups.length})` : message;
			parent = await git.commit({ ...this.base, message: msg, author: this.author, tree, parent: [parent], noUpdateBranch: true });
			out.push(parent);
		}
		// push 전에 로컬 브랜치를 옮겨 둔다 (트리가 같으므로 작업 파일/index는 그대로). 중간에 실패해도 다음 push가 이어서 올린다.
		await git.writeRef({ ...this.base, ref: `refs/heads/${branch}`, value: parent, force: true });
		return out;
	}

	/** HEAD에서 first-parent를 따라 원격에 아직 없는 커밋 목록 (오래된 것 먼저). */
	private async unpushedChain(head: string, remoteTip: string | null): Promise<string[]> {
		const chain: string[] = [];
		let cur: string | undefined = head;
		while (cur && chain.length < 500) {
			if (remoteTip) {
				if (cur === remoteTip) break;
				try {
					if (await git.isDescendent({ ...this.base, oid: remoteTip, ancestor: cur, depth: -1 })) break;
				} catch {
					// 원격 tip을 로컬에서 모르면 계속 내려간다
				}
			}
			chain.unshift(cur);
			try {
				const { commit }: { commit: { parent: string[] } } = await git.readCommit({ ...this.base, oid: cur });
				cur = commit.parent[0];
			} catch {
				break; // shallow 경계
			}
		}
		return chain;
	}

	private async doPush(): Promise<void> {
		const { branch, remoteUrl } = this.cfg();
		if (!remoteUrl) return;
		const head = await this.headOid();
		if (!head) return;

		const refs = await git.listServerRefs({ ...this.remote, prefix: `refs/heads/${branch}` });
		const remoteTip = refs.find((r) => r.ref === `refs/heads/${branch}`)?.oid ?? null;
		if (remoteTip === head) return;

		if (remoteTip) {
			const known = await git.isDescendent({ ...this.base, oid: head, ancestor: remoteTip, depth: -1 }).catch(() => false);
			if (!known) throw new Error("원격에 새 커밋이 있습니다. 먼저 pull 하세요.");
		}

		// isomorphic-git은 '원격 브랜치 이전 tip과의 merge-base'에 있는 객체만 빼고 보낸다.
		// 그래서 커밋을 같은 브랜치에 fast-forward로 하나씩 올리면 매 push가 그 커밋의 변경분(≈chunk)만 담는다.
		// 머지 커밋이 끼어 있으면 그게 안 되므로 원격 tip 위에 다시 쌓는다(linearize).
		let chain = await this.unpushedChain(head, remoteTip);
		if (remoteTip) {
			let linear = true;
			for (let i = 0; i < chain.length && linear; i++) {
				const parents = (await git.readCommit({ ...this.base, oid: chain[i] })).commit.parent;
				linear = parents.length === 1 && (i > 0 || parents[0] === remoteTip);
			}
			if (!linear) chain = await this.linearize(head, remoteTip, chain);
			if (!chain.length) return;
		}
		const steps = chain.slice(0, -1);

		for (const oid of steps) {
			await git.writeRef({ ...this.base, ref: `refs/heads/${TMP_REF}`, value: oid, force: true });
			try {
				const r = await git.push({ ...this.base, ...this.remote, ref: TMP_REF, remoteRef: branch });
				if (!r.ok) throw pushRejected(r);
			} finally {
				await git.deleteRef({ ...this.base, ref: `refs/heads/${TMP_REF}` });
			}
		}
		const res = await git.push({ ...this.base, ...this.remote, ref: branch, remoteRef: branch });
		if (!res.ok) throw pushRejected(res);
	}

	/** 뷰를 새로 그릴 때마다 불리므로 ref만 읽고, HEAD나 원격이 바뀌었을 때만 커밋을 따라가 다시 센다 */
	private async doUnpushedCommits(): Promise<string[]> {
		const { branch, remoteUrl } = this.cfg();
		const head = await this.headOid();
		if (!remoteUrl || !head) return [];
		const tip = await git.resolveRef({ ...this.base, ref: `refs/remotes/origin/${branch}` }).catch(() => null);
		if (tip === head) return [];
		const c = this.unpushedCache;
		if (c?.head === head && c.tip === tip) return c.oids;
		const oids = await this.unpushedChain(head, tip);
		this.unpushedCache = { head, tip, oids };
		return oids;
	}

	// ---------- 공개 메서드: 작업마다 객체 캐시 하나를 공유 (op 참고) ----------

	connect() {
		return this.op(() => this.doConnect());
	}
	changes() {
		return this.op(() => this.doChanges());
	}
	stage(paths: string[]) {
		return this.op(() => this.doStage(paths));
	}
	unstage(paths: string[]) {
		return this.op(() => this.doUnstage(paths));
	}
	commit(message: CommitMessage, stagedOnly = false) {
		return this.op(() => this.doCommit(message, stagedOnly));
	}
	pull() {
		return this.op(() => this.doPull());
	}
	push() {
		return this.op(() => this.doPush());
	}
	unpushedCount() {
		return this.op(async () => (await this.doUnpushedCommits()).length);
	}
	unpushedCommits() {
		return this.op(() => this.doUnpushedCommits());
	}
	async checkRemote(): Promise<boolean> {
		const { branch } = this.cfg();
		const refs = await git.listServerRefs({ ...this.remote, prefix: `refs/heads/${branch}` });
		return refs.some((r) => r.ref === `refs/heads/${branch}`);
	}
	readAt(rev: string, path: string) {
		return this.op(() => this.doReadAt(rev, path));
	}
	conflictVersions(path: string) {
		return this.op(() => this.doConflictVersions(path));
	}
	discard(path: string) {
		return this.op(() => this.doDiscard(path));
	}
	log(limit: number) {
		return this.op(() => this.doLog(limit));
	}
	commitFiles(oid: string) {
		return this.op(() => this.doCommitFiles(oid));
	}
}

function pushRejected(res: git.PushResult): Error {
	const reasons = Object.values(res.refs ?? {}).map((r) => r.error).filter(Boolean);
	const detail = reasons.join(", ") || res.error || "";
	return new Error(`push가 거부되었습니다. 브랜치 보호 규칙과 토큰의 쓰기 권한을 확인하세요.${detail ? ` (${detail})` : ""}`);
}

/** 충돌 사본 이름에 붙일 기기 시각 */
function conflictStamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

/** notes/a.md → notes/a (충돌 사본 2026-11-04 1530).md */
export function conflictCopyPath(path: string, stamp: string): string {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	const [stem, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""];
	return `${stem} (충돌 사본 ${stamp})${ext}`;
}
