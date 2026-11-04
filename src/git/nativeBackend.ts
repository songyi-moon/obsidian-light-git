import { isNewConflictCopy, messageText, type ChangeType, type CommitInfo, type CommitMessage, type ConflictVersions, type FileChange, type GitBackend, type GitConfig, type WorkChange } from "./types";

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** 데스크톱용: 시스템에 설치된 git을 그대로 실행. 인증은 사용자의 credential helper / SSH 설정을 따른다. */
export class NativeBackend implements GitBackend {
	readonly name = "native git";

	constructor(
		private cwd: string,
		private cfg: () => GitConfig,
		private gitPath = "git",
	) {}

	private run(args: string[]): Promise<RunResult> {
		// 모바일 번들에서도 로드만은 되도록 child_process는 실행 시점에만 require
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { execFile } = require("child_process") as typeof import("child_process");
		return new Promise((resolve) => {
			execFile(this.gitPath, args, { cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
				const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
				resolve({ code, stdout: String(stdout), stderr: String(stderr) });
			});
		});
	}

	private async git(...args: string[]): Promise<string> {
		const r = await this.run(args);
		if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} 실패 (${r.code})`);
		return r.stdout;
	}

	static async available(cwd: string, gitPath = "git"): Promise<boolean> {
		try {
			const b = new NativeBackend(cwd, () => ({}) as GitConfig, gitPath);
			return (await b.run(["--version"])).code === 0;
		} catch {
			return false;
		}
	}

	private author(): string[] {
		const c = this.cfg();
		const args: string[] = [];
		if (c.authorName) args.push("-c", `user.name=${c.authorName}`);
		if (c.authorEmail) args.push("-c", `user.email=${c.authorEmail}`);
		return args;
	}

	async isRepo(): Promise<boolean> {
		// 이 폴더 자체가 저장소 최상위여야 한다 (vault 루트에 예전 .git이 있으면 하위 폴더도 그 안으로 잡히므로)
		const r = await this.run(["rev-parse", "--show-prefix"]);
		return r.code === 0 && r.stdout.trim() === "";
	}

	private async hasHead(): Promise<boolean> {
		return (await this.run(["rev-parse", "--verify", "HEAD"])).code === 0;
	}

	async connect(): Promise<string> {
		const { branch, remoteUrl } = this.cfg();
		if (!remoteUrl) throw new Error("원격 저장소 URL을 설정에서 입력하세요.");
		if (!(await this.isRepo())) await this.git("init", "-b", branch);
		const remotes = (await this.git("remote")).split("\n").map((s) => s.trim());
		if (remotes.includes("origin")) await this.git("remote", "set-url", "origin", remoteUrl);
		else await this.git("remote", "add", "origin", remoteUrl);

		const ls = await this.git("ls-remote", "--heads", "origin", branch);
		if (!ls.trim()) return "원격 저장소가 비어 있습니다. 동기화하면 현재 vault가 올라갑니다.";
		if (await this.hasHead()) {
			const conflicts = await this.pull();
			return conflicts.length ? `원격과 병합 중 충돌 ${conflicts.length}건` : "원격과 병합했습니다.";
		}
		await this.git("fetch", "origin", branch);
		await this.git("checkout", "-f", "-B", branch, "--track", `origin/${branch}`);
		return "원격 저장소를 받아왔습니다.";
	}

	async changes(): Promise<WorkChange[]> {
		const out = await this.git("status", "--porcelain=v1", "-z", "-uall");
		const parts = out.split("\0");
		const res: WorkChange[] = [];
		for (let i = 0; i < parts.length; i++) {
			const entry = parts[i];
			if (entry.length < 4) continue;
			const xy = entry.slice(0, 2);
			const path = entry.slice(3);
			if (xy[0] === "R" || xy[0] === "C") i++; // -z 포맷: rename은 원래 경로가 다음 항목
			const type = xy.includes("?") || xy.includes("A") ? "added" : xy.includes("D") ? "deleted" : "modified";
			// X = index(스테이징) 상태, Y = 작업 파일 상태
			res.push({ path, type, staged: xy[0] !== " " && xy[0] !== "?", unstaged: xy[1] !== " " });
		}
		return res;
	}

	async stage(paths: string[]): Promise<void> {
		if (paths.length) await this.git("add", "-A", "--", ...paths);
	}

	async unstage(paths: string[]): Promise<void> {
		if (!paths.length) return;
		if (await this.hasHead()) await this.git("reset", "-q", "--", ...paths);
		else await this.git("rm", "--cached", "-r", "-q", "--ignore-unmatch", "--", ...paths);
	}

	async isMerging(): Promise<boolean> {
		return (await this.run(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
	}

	async conflicts(): Promise<string[]> {
		const out = await this.git("diff", "--name-only", "--diff-filter=U", "-z");
		return out.split("\0").filter(Boolean);
	}

	async markResolved(path: string): Promise<void> {
		// 머지 화면에서 삭제를 고른 경우 파일이 없으므로 -A로 삭제까지 반영
		await this.git("add", "-A", "--", path);
	}

	async readAt(rev: string, path: string): Promise<string | null> {
		const r = await this.run(["show", `${rev}:${path}`]);
		return r.code === 0 ? r.stdout : null;
	}

	async conflictVersions(path: string): Promise<ConflictVersions> {
		// index stage 1/2/3 = base/ours/theirs
		return {
			base: await this.readAt(":1", path),
			ours: await this.readAt(":2", path),
			theirs: await this.readAt(":3", path),
		};
	}

	async discard(path: string): Promise<void> {
		if ((await this.run(["cat-file", "-e", `HEAD:${path}`])).code === 0) {
			await this.git("checkout", "HEAD", "--", path);
			return;
		}
		await this.run(["rm", "--cached", "--ignore-unmatch", "-q", "--", path]);
		await this.run(["clean", "-f", "-q", "--", path]);
	}

	async log(limit: number): Promise<CommitInfo[]> {
		if (!(await this.hasHead())) return [];
		const out = await this.git("log", "-n", String(limit), "--format=%H%x1f%P%x1f%an%x1f%at%x1f%B%x1e");
		return out
			.split("\x1e")
			.map((r) => r.replace(/^\n/, ""))
			.filter(Boolean)
			.map((r) => {
				const [oid, parents, author, at, message] = r.split("\x1f");
				return { oid, parent: parents.split(" ")[0] || undefined, author, timestamp: Number(at), message: (message ?? "").trim() };
			});
	}

	async commitFiles(oid: string): Promise<FileChange[]> {
		const out = await this.git("show", "--name-status", "--format=", "--no-renames", "-z", oid);
		const parts = out.split("\0").filter(Boolean);
		const res: FileChange[] = [];
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const st = parts[i].trim();
			const type: ChangeType = st === "A" ? "added" : st === "D" ? "deleted" : "modified";
			res.push({ path: parts[i + 1], type });
		}
		return res;
	}

	async commit(message: CommitMessage, stagedOnly = false): Promise<number> {
		const unresolved = await this.conflicts();
		if (unresolved.length) throw new Error(`해결되지 않은 충돌 ${unresolved.length}건이 있습니다.`);
		const merging = await this.isMerging();
		if (!stagedOnly || merging) await this.git("add", "-A");
		await this.unstage((await this.changes()).filter((c) => c.staged && isNewConflictCopy(c)).map((c) => c.path));
		const staged = await this.run(["diff", "--cached", "--quiet"]);
		if (staged.code === 0 && !merging) return 0;
		const text = typeof message === "string" ? message : messageText(message, (await this.changes()).filter((c) => c.staged).length);
		await this.git(...this.author(), "commit", "-m", text);
		return 1;
	}

	async pull(): Promise<string[]> {
		const { branch, remoteUrl } = this.cfg();
		if (!remoteUrl) return [];
		const merging = await this.conflicts();
		if (merging.length) return merging;
		if (!(await this.hasHead())) {
			await this.connect();
			return [];
		}
		// ls-remote로 미리 확인하지 않고 바로 pull (네트워크 왕복 1회 절약). 원격 브랜치가 아직 없으면 할 일 없음.
		const r = await this.run([...this.author(), "pull", "--no-rebase", "--no-edit", "origin", branch]);
		if (r.code === 0) return [];
		const conflicts = await this.conflicts();
		if (conflicts.length) return conflicts;
		// 실패 원인이 '원격 브랜치 없음'인지는 실패했을 때만 확인 (git 메시지는 언어 설정에 따라 달라서 문자열로 판단하지 않음)
		if (!(await this.git("ls-remote", "--heads", "origin", branch)).trim()) return [];
		throw new Error(r.stderr.trim() || "pull 실패");
	}

	async push(): Promise<void> {
		const { branch, remoteUrl } = this.cfg();
		if (!remoteUrl || !(await this.hasHead())) return;
		await this.git("push", "-u", "origin", branch);
	}

	async checkRemote(): Promise<boolean> {
		const { branch, remoteUrl } = this.cfg();
		return (await this.git("ls-remote", "--heads", remoteUrl, branch)).trim().length > 0;
	}

	async unpushedCount(): Promise<number> {
		const { branch, remoteUrl } = this.cfg();
		if (!remoteUrl || !(await this.hasHead())) return 0;
		const tracked = await this.run(["rev-list", "--count", "--first-parent", `refs/remotes/origin/${branch}..HEAD`]);
		// 원격 추적 ref가 없으면 아직 한 번도 올리지 않은 것
		return Number(tracked.code === 0 ? tracked.stdout : await this.git("rev-list", "--count", "--first-parent", "HEAD"));
	}
}
