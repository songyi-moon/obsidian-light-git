import * as git from "isomorphic-git";
import { messageText, type CommitInfo, type CommitMessage, type ConflictVersions, type FileChange, type GitBackend, type GitConfig, type WorkChange } from "./types";

/** 분할 push 때 커밋 하나를 가리키는 로컬 전용 임시 ref (원격에는 생기지 않음) */
const TMP_REF = "light-git-push-step";
const MERGE_HEAD = ".git/MERGE_HEAD";
const CONFLICTS = ".git/LIGHT_GIT_CONFLICTS";
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
	lstat(path: string): Promise<{ size: number }>;
	mkdir(path: string): Promise<void>;
}

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
	) {}

	private get base() {
		// 런타임엔 promise 기반 평면 fs로 인식된다 (isomorphic-git의 isPromiseFs 검사)
		return { fs: this.fs as unknown as git.FsClient, dir: this.dir };
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

	async connect(): Promise<string> {
		const { branch, remoteUrl } = this.cfg();
		if (!remoteUrl) throw new Error("원격 저장소 URL을 설정에서 입력하세요.");
		if (!(await this.isRepo())) {
			await git.init({ ...this.base, defaultBranch: branch });
			if (!(await this.exists(".gitignore"))) await this.fs.writeFile(".gitignore", DEFAULT_GITIGNORE);
		}
		await git.addRemote({ ...this.base, remote: "origin", url: remoteUrl, force: true });
		await git.setConfig({ ...this.base, path: `branch.${branch}.remote`, value: "origin" });
		await git.setConfig({ ...this.base, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });

		const refs = await git.listServerRefs({ ...this.remote, prefix: `refs/heads/${branch}` });
		if (!refs.some((r) => r.ref === `refs/heads/${branch}`)) {
			return "원격 저장소가 비어 있습니다. 동기화하면 현재 vault가 올라갑니다.";
		}
		if (await this.headOid()) {
			const conflicts = await this.pull();
			return conflicts.length ? `원격과 병합 중 충돌 ${conflicts.length}건` : "원격과 병합했습니다.";
		}
		await this.checkoutRemote(true);
		return "원격 저장소를 받아왔습니다.";
	}

	/** 로컬 커밋이 없을 때: 원격 브랜치를 그대로 가져와 working tree에 반영 (clone과 동일). */
	private async checkoutRemote(shallow: boolean) {
		const { branch } = this.cfg();
		const res = await git.fetch({ ...this.base, ...this.remote, ref: branch, singleBranch: true, tags: false, depth: shallow ? 1 : undefined });
		if (!res.fetchHead) return;
		await git.writeRef({ ...this.base, ref: `refs/heads/${branch}`, value: res.fetchHead, force: true });
		await git.checkout({ ...this.base, ref: branch, force: true });
	}

	async changes(): Promise<WorkChange[]> {
		const matrix = await git.statusMatrix({ ...this.base, cache: {} });
		const out: WorkChange[] = [];
		// statusMatrix 값: head/workdir 0=없음 1=HEAD와 같음 2=다름, stage 0=없음 1=HEAD와 같음 2=작업 파일과 같음 3=둘 다와 다름
		for (const [path, head, workdir, stage] of matrix) {
			const staged = head === 0 ? stage !== 0 : stage !== 1;
			const unstaged = stage === 2 ? false : stage === 3 ? true : stage === 1 ? workdir !== 1 : workdir !== 0;
			if (!staged && !unstaged) continue;
			out.push({ path, type: head === 0 ? "added" : workdir === 0 ? "deleted" : "modified", staged, unstaged });
		}
		return out;
	}

	async stage(paths: string[]): Promise<void> {
		const adds: string[] = [];
		for (const p of paths) {
			if (await this.exists(p)) adds.push(p);
			else await git.remove({ ...this.base, filepath: p });
		}
		if (adds.length) await git.add({ ...this.base, filepath: adds, cache: {} });
	}

	async unstage(paths: string[]): Promise<void> {
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
		return !!(await this.readMergeHead());
	}

	async conflicts(): Promise<string[]> {
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

	async readAt(rev: string, path: string): Promise<string | null> {
		const blob = await this.readBlobAt(rev, path);
		return blob ? decoder.decode(blob) : null;
	}

	async conflictVersions(path: string): Promise<ConflictVersions> {
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

	async discard(path: string): Promise<void> {
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

	async log(limit: number): Promise<CommitInfo[]> {
		if (!(await this.headOid())) return [];
		const entries = await git.log({ ...this.base, ref: "HEAD", depth: limit });
		return entries.map((e) => ({
			oid: e.oid,
			parent: e.commit.parent[0],
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

	async commitFiles(oid: string): Promise<FileChange[]> {
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

	async commit(message: CommitMessage, stagedOnly = false): Promise<number> {
		const mergeHead = await this.readMergeHead();
		if (mergeHead) {
			const unresolved = await this.conflicts();
			if (unresolved.length) throw new Error(`해결되지 않은 충돌 ${unresolved.length}건이 있습니다.`);
			const head = await this.headOid();
			const pending = await this.changes();
			await this.stage(pending.map((c) => c.path));
			await git.commit({ ...this.base, message: messageText(message, pending.length), author: this.author, parent: [head!, mergeHead] });
			await this.clearMergeState();
			return 1;
		}

		const all = await this.changes();
		const changes = stagedOnly ? all.filter((c) => c.staged) : all;
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

	async pull(): Promise<string[]> {
		const { branch, remoteUrl } = this.cfg();
		if (!remoteUrl) return [];
		if (await this.readMergeHead()) return this.conflicts();
		const head = await this.headOid();
		if (!head) {
			await this.checkoutRemote(true);
			return [];
		}
		const res = await git.fetch({ ...this.base, ...this.remote, ref: branch, singleBranch: true, tags: false });
		const theirs = res.fetchHead;
		if (!theirs || theirs === head) return [];
		// 로컬이 앞서 있기만 하면(원격 새 커밋 없음) merge/checkout은 할 일이 없다 — checkout은 vault 전체를 훑으므로 비싸다
		if (await git.isDescendent({ ...this.base, oid: head, ancestor: theirs, depth: -1 }).catch(() => false)) return [];
		await this.assertNoOverlap(head, theirs);
		try {
			await git.merge({
				...this.base,
				ours: branch,
				theirs,
				author: this.author,
				abortOnConflict: false,
				allowUnrelatedHistories: true,
				message: `Merge remote-tracking branch 'origin/${branch}'`,
			});
		} catch (e) {
			if (e instanceof git.Errors.MergeConflictError) {
				await this.fs.writeFile(MERGE_HEAD, theirs + "\n");
				const rec: ConflictRecord = { paths: e.data.filepaths, markerless: [...e.data.deleteByUs, ...e.data.deleteByTheirs] };
				await this.fs.writeFile(CONFLICTS, JSON.stringify(rec));
				return e.data.filepaths;
			}
			throw e;
		}
		await git.checkout({ ...this.base, ref: branch });
		return [];
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

	async push(): Promise<void> {
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
				if (!r.ok) throw new Error(`push 거부됨: ${JSON.stringify(r.refs)}`);
			} finally {
				await git.deleteRef({ ...this.base, ref: `refs/heads/${TMP_REF}` });
			}
		}
		const res = await git.push({ ...this.base, ...this.remote, ref: branch, remoteRef: branch });
		if (!res.ok) throw new Error(`push 거부됨: ${JSON.stringify(res.refs)}`);
	}
}
