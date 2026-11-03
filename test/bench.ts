// 성능 측정: 노트 N개 vault에서 동작별 시간 + 파일 API 호출 수 (iOS에선 호출 1회가 비쌈)
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import nodeHttp from "isomorphic-git/http/node";
import { MockAdapter } from "./mockAdapter";
import { startGitServer } from "./gitServer";
import { ObsidianFs } from "../src/git/obsidianFs";
import { IsoBackend } from "../src/git/isoBackend";
import { NativeBackend } from "../src/git/nativeBackend";
import type { GitConfig } from "../src/git/types";

const N = Number(process.env.NOTES ?? 2000);
const HIST = Number(process.env.HIST ?? 100);
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

const counts: Record<string, number> = {};
function counting<T extends object>(target: T): T {
	return new Proxy(target, {
		get(t, k, r) {
			const v = Reflect.get(t, k, r);
			if (typeof v !== "function") return v;
			return (...a: unknown[]) => {
				counts[String(k)] = (counts[String(k)] ?? 0) + 1;
				return v.apply(t, a);
			};
		},
	});
}
async function measure(label: string, fn: () => Promise<unknown>) {
	for (const k of Object.keys(counts)) delete counts[k];
	const t = Date.now();
	await fn();
	const calls = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ");
	console.log(`${label.padEnd(34)} ${String(Date.now() - t).padStart(6)}ms  ${calls}`);
}

async function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightgit-bench-"));
	const remoteRoot = path.join(tmp, "remote");
	fs.mkdirSync(remoteRoot);
	const bare = path.join(remoteRoot, "vault.git");
	execFileSync("git", ["init", "--bare", "-b", "main", bare]);
	sh(bare, "config", "http.receivepack", "true");
	// 시드: 노트 N개 + 히스토리 HIST개 커밋
	const seed = path.join(tmp, "seed");
	fs.mkdirSync(seed);
	sh(seed, "init", "-b", "main");
	sh(seed, "config", "user.name", "s");
	sh(seed, "config", "user.email", "s@s");
	for (let i = 0; i < N; i++) {
		const p = path.join(seed, `folder${i % 40}`, `note${i}.md`);
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, `# note ${i}\n` + "lorem ipsum dolor sit amet\n".repeat(40));
	}
	sh(seed, "add", "-A");
	sh(seed, "commit", "-qm", "seed");
	for (let h = 0; h < HIST; h++) {
		fs.appendFileSync(path.join(seed, `folder${h % 40}`, `note${h}.md`), `edit ${h}\n`);
		sh(seed, "commit", "-qam", `edit ${h}`);
	}
	sh(seed, "push", "-q", bare, "main");
	const server = await startGitServer(remoteRoot);
	const cfg = (): GitConfig => ({ remoteUrl: `${server.url}/vault.git`, branch: "main", username: "", token: "", authorName: "b", authorEmail: "b@b", chunkBytes: 20 * 1024 * 1024 });

	console.log(`notes=${N} history=${HIST}`);
	console.log("— isomorphic-git (iOS 엔진) —");
	const root = path.join(tmp, "iso");
	fs.mkdirSync(root);
	const b = new IsoBackend(new ObsidianFs(counting(new MockAdapter(root)) as any), nodeHttp, cfg);
	await measure("connect (최초 받기)", () => b.connect());
	await measure("changes() 1회차", () => b.changes());
	await measure("changes() 변경 없음", () => b.changes());
	fs.appendFileSync(path.join(root, "folder1/note1.md"), "local\n");
	await measure("뷰 새로고침 (conflicts+changes)", async () => (await b.conflicts(), await b.changes()));
	await measure("commit 1파일", () => b.commit("one"));
	await measure("pull (원격 변경 없음)", () => b.pull());
	await measure("push 1커밋", () => b.push());
	await measure("동기화 변경 없음 (changes+commit+pull+push)", async () => {
		await b.changes();
		await b.commit("x");
		await b.pull();
		await b.push();
	});
	fs.appendFileSync(path.join(seed, "folder2/note2.md"), "remote\n");
	sh(seed, "commit", "-qam", "remote edit");
	sh(seed, "pull", "-q", "--no-rebase", "--no-edit", bare, "main");
	sh(seed, "push", "-q", bare, "main");
	fs.appendFileSync(path.join(root, "folder3/note3.md"), "local2\n");
	await measure("동기화: 로컬1 + 원격1 (diverged)", async () => {
		await b.changes();
		await b.commit("y");
		await b.pull();
		await b.push();
	});

	console.log("— native git (데스크톱) —");
	const croot = path.join(tmp, "native");
	fs.mkdirSync(croot);
	const c = new NativeBackend(croot, cfg);
	await measure("connect", () => c.connect());
	await measure("changes()", () => c.changes());
	fs.appendFileSync(path.join(croot, "folder5/note5.md"), "local\n");
	await measure("동기화 1파일", async () => {
		await c.changes();
		await c.commit("n");
		await c.pull();
		await c.push();
	});

	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
}
main().catch((e) => {
	console.error(e);
	process.exit(1);
});
