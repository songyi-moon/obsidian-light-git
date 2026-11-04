// 앱이 작업 도중 꺼진 뒤(iOS는 앱을 내리면 끊긴다) 다시 켜서 동기화해도 데이터가 망가지지 않는지 + 한글 파일명.
// "재시작"은 새 IsoBackend로 흉내 낸다 (메모리 상태 없이 디스크에 남은 것만으로 이어간다).
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import nodeHttp from "isomorphic-git/http/node";
import type { HttpClient } from "isomorphic-git";
import { CountingAdapter, MockAdapter } from "./mockAdapter";
import { startGitServer } from "./gitServer";
import { ObsidianFs } from "../src/git/obsidianFs";
import { IsoBackend } from "../src/git/isoBackend";
import type { GitBackend, GitConfig } from "../src/git/types";

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
	if (!cond) failed++;
}
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const write = (root: string, p: string, d: string | Buffer) => {
	fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
	fs.writeFileSync(path.join(root, p), d);
};
const read = (root: string, p: string) => fs.readFileSync(path.join(root, p), "utf8");
const has = (root: string, p: string) => fs.existsSync(path.join(root, p));

/** 플러그인의 동기화와 같은 순서 */
async function sync(b: GitBackend, msg: string) {
	const n = await b.commit(msg);
	const conflicts = await b.pull();
	if (!conflicts.length) await b.push();
	return { n, conflicts };
}

/** APFS(iOS)처럼 정규화가 달라도 같은 파일로 찾지만, 이름은 저장된 그대로 돌려주는 어댑터 */
class NormalizationInsensitiveAdapter extends MockAdapter {
	private real(p: string): string {
		let cur = "";
		for (const seg of p.split("/").filter(Boolean)) {
			const dir = path.join(this.root, cur);
			const found = fs.existsSync(dir) ? fs.readdirSync(dir).find((n) => n.normalize("NFC") === seg.normalize("NFC")) : undefined;
			cur = cur ? `${cur}/${found ?? seg}` : (found ?? seg);
		}
		return cur || p;
	}
	stat(p: string) {
		return super.stat(this.real(p));
	}
	exists(p: string) {
		return super.exists(this.real(p));
	}
	read(p: string) {
		return super.read(this.real(p));
	}
	readBinary(p: string) {
		return super.readBinary(this.real(p));
	}
	write(p: string, d: string) {
		return super.write(this.real(p), d);
	}
	writeBinary(p: string, d: ArrayBuffer) {
		return super.writeBinary(this.real(p), d);
	}
	mkdir(p: string) {
		return super.mkdir(this.real(p));
	}
	remove(p: string) {
		return super.remove(this.real(p));
	}
	list(p: string) {
		return super.list(this.real(p));
	}
}

async function main() {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightgit-res-"));
	const remoteRoot = path.join(tmp, "remote");
	fs.mkdirSync(remoteRoot);
	const bare = path.join(remoteRoot, "vault.git");
	execFileSync("git", ["init", "--bare", "-b", "main", bare]);
	sh(bare, "config", "http.receivepack", "true");
	sh(bare, "config", "uploadpack.allowFilter", "true");
	const server = await startGitServer(remoteRoot);
	const cfg = (name: string, chunkBytes = 5 * 1024 * 1024): (() => GitConfig) => () => ({
		remoteUrl: `${server.url}/vault.git`,
		branch: "main",
		username: "",
		token: "",
		authorName: name,
		authorEmail: `${name}@test`,
		chunkBytes,
	});
	/** 같은 폴더를 여는 새 백엔드 = 앱 재시작 */
	const device = (name: string, chunkBytes?: number) => {
		const root = path.join(tmp, name);
		fs.mkdirSync(root, { recursive: true });
		const ad = new CountingAdapter(root);
		const open = (http: HttpClient = nodeHttp) => new IsoBackend(new ObsidianFs(ad as any), http, cfg(name, chunkBytes));
		return { root, ad, open, b: open() };
	};
	const remoteHas = (p: string) => sh(bare, "ls-tree", "-r", "--name-only", "-z", "main").split("\0").includes(p);
	const remoteRead = (p: string) => sh(bare, "show", `main:${p}`);

	const PC = device("PC");
	for (const n of ["a", "b", "c", "d", "e", "f"]) write(PC.root, `notes/${n}.md`, `${n} 원본\n`);
	await PC.b.connect();
	await sync(PC.b, "first");
	const P = device("Phone");
	await P.b.connect();

	console.log("— pull: 파일을 쓰는 중 앱이 꺼짐 —");
	for (const n of ["a", "c", "e"]) write(PC.root, `notes/${n}.md`, `${n} PC 수정\n`);
	write(PC.root, "notes/new.md", "PC 새 파일\n");
	fs.unlinkSync(path.join(PC.root, "notes/f.md"));
	await sync(PC.b, "pc edits");
	write(P.root, "notes/memo.md", "폰에서 쓴 글\n"); // pull과 겹치지 않는, 커밋 전 변경
	P.ad.failOn = (p) => p.endsWith("notes/c.md");
	const cut1 = await P.b.pull().then(() => false, () => true);
	P.ad.failOn = null;
	check("pull ff cut: the pull really failed midway", cut1);
	const afterCrash = await P.open().changes();
	check("pull ff cut: after restart, remote's edits don't look like mine", !afterCrash.some((c) => c.path !== "notes/memo.md"), JSON.stringify(afterCrash.map((c) => `${c.type}:${c.path}`)));
	await sync(P.open(), "after crash");
	check("pull ff cut: next sync doesn't revert the remote", remoteRead("notes/c.md") === "c PC 수정\n" && remoteRead("notes/a.md") === "a PC 수정\n" && remoteRead("notes/new.md") === "PC 새 파일\n" && !remoteHas("notes/f.md"), JSON.stringify({ c: remoteRead("notes/c.md"), new: remoteHas("notes/new.md"), f: remoteHas("notes/f.md") }));
	check("pull ff cut: device catches up", read(P.root, "notes/c.md") === "c PC 수정\n" && read(P.root, "notes/e.md") === "e PC 수정\n" && read(P.root, "notes/new.md") === "PC 새 파일\n" && !has(P.root, "notes/f.md"));
	check("pull ff cut: uncommitted note survives and goes up", read(P.root, "notes/memo.md") === "폰에서 쓴 글\n" && remoteRead("notes/memo.md") === "폰에서 쓴 글\n");
	await PC.b.pull();

	console.log("— pull: 로컬 커밋과 병합 후 파일을 쓰는 중 꺼짐 —");
	write(PC.root, "notes/b.md", "b PC 수정\n");
	write(PC.root, "notes/d.md", "d PC 수정\n");
	await sync(PC.b, "pc edits 2");
	write(P.root, "notes/phone.md", "폰 커밋\n");
	await P.b.commit("phone commit");
	P.ad.failOn = (p) => p.endsWith("notes/d.md");
	const cut2 = await P.b.pull().then(() => false, () => true);
	P.ad.failOn = null;
	check("pull merge cut: the pull really failed midway", cut2);
	await sync(P.open(), "after crash 2");
	check("pull merge cut: next sync keeps both sides", remoteRead("notes/b.md") === "b PC 수정\n" && remoteRead("notes/d.md") === "d PC 수정\n" && remoteRead("notes/phone.md") === "폰 커밋\n", JSON.stringify({ b: remoteRead("notes/b.md"), d: remoteRead("notes/d.md") }));
	check("pull merge cut: device catches up", read(P.root, "notes/d.md") === "d PC 수정\n" && (await P.open().changes()).length === 0, JSON.stringify(await P.open().changes()));
	await PC.b.pull();

	console.log("— pull: 충돌 파일을 쓰는 중 꺼짐 —");
	write(PC.root, "notes/a.md", "a PC 충돌\n");
	write(PC.root, "notes/z.md", "z PC 새 파일\n");
	await sync(PC.b, "pc conflict");
	write(P.root, "notes/a.md", "a 폰 충돌\n");
	await P.b.commit("phone conflict");
	P.ad.failOn = (p) => p.endsWith("MERGE_HEAD"); // 충돌 마커까지 다 썼고, 머지 중이라는 기록을 남기기 전
	const cut3 = await P.b.pull().then(() => false, () => true);
	P.ad.failOn = null;
	check("conflict cut: the pull really failed midway", cut3 && read(P.root, "notes/a.md").includes("<<<<<<<"));
	const P3 = P.open();
	check("conflict cut: the conflict is reported again after restart", (await P3.isMerging()) && (await P3.conflicts()).includes("notes/a.md"), JSON.stringify(await P3.conflicts()));
	const blocked = await P3.commit("must not commit markers").then(() => false, () => true);
	check("conflict cut: no conflict markers can be committed", blocked && !remoteRead("notes/a.md").includes("<<<<<<<"), JSON.stringify(remoteRead("notes/a.md")));
	const v = await P3.conflictVersions("notes/a.md");
	check("conflict cut: both versions still available", v.ours === "a 폰 충돌\n" && v.theirs === "a PC 충돌\n", JSON.stringify(v));
	write(P.root, "notes/a.md", "a 합침\n");
	await P3.markResolved("notes/a.md");
	await sync(P3, "resolved");
	check("conflict cut: resolving finishes the job", remoteRead("notes/a.md") === "a 합침\n" && remoteRead("notes/z.md") === "z PC 새 파일\n" && read(P.root, "notes/z.md") === "z PC 새 파일\n");
	await PC.b.pull();

	console.log("— 꺼진 뒤 다시 켜기 전에 사용자가 파일을 고침 —");
	write(PC.root, "notes/b.md", "b PC 재수정\n");
	write(PC.root, "notes/c.md", "c PC 재수정\n");
	await sync(PC.b, "pc edits 3");
	P.ad.failOn = (p) => p.endsWith("notes/c.md");
	await P.b.pull().catch(() => {});
	P.ad.failOn = null;
	write(P.root, "notes/c.md", "c 폰에서 끊긴 뒤 고침\n");
	await sync(P.open(), "after crash 4");
	const copy = fs.readdirSync(path.join(P.root, "notes")).find((n) => n.startsWith("c (충돌 사본"));
	check("edit after cut: remote's version wins, my edit kept as a copy", remoteRead("notes/c.md") === "c PC 재수정\n" && read(P.root, "notes/c.md") === "c PC 재수정\n" && !!copy && read(P.root, `notes/${copy}`) === "c 폰에서 끊긴 뒤 고침\n", String(copy));
	check("edit after cut: file written before the cut is fine", read(P.root, "notes/b.md") === "b PC 재수정\n");
	await PC.b.pull();

	console.log("— 같은 세션에서 다음 조회가 바로 복구함 (앱은 안 꺼졌는데 쓰기만 실패) —");
	write(PC.root, "notes/e.md", "e PC 재수정\n");
	await sync(PC.b, "pc edits 4");
	P.ad.failOn = (p) => p.endsWith("notes/e.md");
	await P.b.pull().catch(() => {});
	P.ad.failOn = null;
	const same = await P.b.changes();
	check("same session: next look heals the vault", read(P.root, "notes/e.md") === "e PC 재수정\n" && !same.some((c) => c.path === "notes/e.md"), JSON.stringify(same.map((c) => c.path)));
	fs.unlinkSync(path.join(P.root, `notes/${copy}`));

	console.log("— 복구하는 중에 또 꺼짐 —");
	write(PC.root, "notes/b.md", "b PC 3차\n");
	write(PC.root, "notes/e.md", "e PC 3차\n");
	await sync(PC.b, "pc edits 5");
	P.ad.failOn = (p) => p.endsWith("notes/e.md");
	await P.b.pull().catch(() => {});
	const again = await P.open().changes().then(() => false, () => true);
	P.ad.failOn = null;
	check("cut during recovery: recovery itself failed", again);
	const healed = await P.open().changes();
	check("cut during recovery: next start finishes, no needless copies", read(P.root, "notes/e.md") === "e PC 3차\n" && read(P.root, "notes/b.md") === "b PC 3차\n" && healed.length === 0, JSON.stringify(healed.map((c) => c.path)));

	console.log("— 충돌을 쓰다 꺼진 뒤 사용자가 파일을 고침 —");
	write(PC.root, "notes/a.md", "a PC 또 충돌\n");
	await sync(PC.b, "pc conflict 2");
	write(P.root, "notes/a.md", "a 폰 또 충돌\n");
	await P.b.commit("phone conflict 2");
	P.ad.failOn = (p) => p.endsWith("MERGE_HEAD");
	await P.b.pull().catch(() => {});
	P.ad.failOn = null;
	write(P.root, "notes/a.md", "꺼진 뒤 직접 고친 글\n");
	const P5 = P.open();
	const left = await P5.conflicts();
	const copy2 = fs.readdirSync(path.join(P.root, "notes")).find((n) => n.startsWith("a (충돌 사본"));
	check("conflict + edit after cut: edit kept as a copy, conflict shown", left.includes("notes/a.md") && !!copy2 && read(P.root, `notes/${copy2}`) === "꺼진 뒤 직접 고친 글\n", JSON.stringify({ left, copy2 }));
	write(P.root, "notes/a.md", "a 또 합침\n");
	await P5.markResolved("notes/a.md");
	await sync(P5, "resolved 2");
	fs.unlinkSync(path.join(P.root, `notes/${copy2}`));
	await PC.b.pull();

	console.log("— 분할 커밋·분할 push가 끊김 —");
	const S = device("Split", 100 * 1024);
	await S.b.connect();
	const big = (n: number) => require("crypto").randomBytes(80 * 1024) as Buffer;
	const blobs = Array.from({ length: 5 }, (_, i) => big(i));
	blobs.forEach((d, i) => write(S.root, `big/f${i}.bin`, d));
	let refWrites = 0;
	S.ad.failOn = (p) => p.endsWith("refs/heads/main") && ++refWrites > 2;
	const cutCommit = await S.b.commit("split").then(() => false, () => true);
	S.ad.failOn = null;
	check("split commit cut: the commit really failed midway", cutCommit, `refWrites=${refWrites}`);
	await S.open().commit("split again");
	check("split commit cut: finished after restart", (await S.open().changes()).length === 0, JSON.stringify(await S.open().changes()));
	const total = Number(sh(S.root, "rev-list", "--count", "HEAD", "^origin/main").trim());
	await S.open().pull();

	// 요청을 보내기 전에 끊김
	let posts = 0;
	const cutBefore: HttpClient = { request: async (a) => {
		if (a.method === "POST" && a.url.includes("receive-pack") && ++posts > 1) throw new Error("connection lost");
		return nodeHttp.request(a);
	} };
	const cut4 = await S.open(cutBefore).push().then(() => false, () => true);
	check("split push cut: stopped after the first step", cut4 && total >= 3, `commits=${total}`);
	const partial = sh(bare, "rev-parse", "main").trim();
	check("split push cut: remote moved only partway", partial !== sh(S.root, "rev-parse", "HEAD").trim());
	// 앱이 꺼져서 임시 ref가 남은 경우
	sh(S.root, "branch", "-f", "light-git-push-step", "HEAD");
	await S.open().push();
	check("split push cut: resumes to the end", sh(bare, "rev-parse", "main").trim() === sh(S.root, "rev-parse", "HEAD").trim() && blobs.every((d, i) => execFileSync("git", ["show", `main:big/f${i}.bin`], { cwd: bare }).equals(d)));

	// 원격이 받았는데 응답을 못 받음
	const more = big(9);
	write(S.root, "big/g0.bin", more);
	write(S.root, "big/g1.bin", big(10));
	await S.open().commit("more");
	posts = 0;
	const lostReply: HttpClient = { request: async (a) => {
		const res = await nodeHttp.request(a);
		if (a.method === "POST" && a.url.includes("receive-pack") && ++posts === 1) {
			for await (const _ of res.body as AsyncIterable<Uint8Array>) void _; // 서버 처리가 끝나길 기다린다
			throw new Error("reply lost");
		}
		return res;
	} };
	const cut5 = await S.open(lostReply).push().then(() => false, () => true);
	check("push reply lost: reported as failed", cut5);
	await sync(S.open(), "retry");
	check("push reply lost: retry ends in sync", sh(bare, "rev-parse", "main").trim() === sh(S.root, "rev-parse", "HEAD").trim() && (await S.open().changes()).length === 0 && execFileSync("git", ["show", "main:big/g0.bin"], { cwd: bare }).equals(more));
	await PC.b.pull();

	console.log("— 한글 파일명 (NFC/NFD) —");
	const nfc = "notes/회의록.md".normalize("NFC");
	const nfd = nfc.normalize("NFD");
	check("test names really differ", nfc !== nfd);
	write(PC.root, nfc, "PC에서 만든 회의록\n");
	await sync(PC.b, "nfc name");
	const Iroot = path.join(tmp, "iPhone");
	fs.mkdirSync(path.join(Iroot, "notes"), { recursive: true });
	const iAd = new NormalizationInsensitiveAdapter(Iroot);
	const I = new IsoBackend(new ObsidianFs(iAd as any), nodeHttp, cfg("iPhone"));
	await I.connect();
	// 같은 파일이 디스크에는 NFD 이름으로 저장된 경우 (Mac·파일 앱에서 넘어온 파일)
	fs.renameSync(path.join(Iroot, nfc), path.join(Iroot, nfd));
	const unchanged = await new IsoBackend(new ObsidianFs(iAd as any), nodeHttp, cfg("iPhone")).changes();
	check("nfd on disk: unchanged file shows no change", unchanged.length === 0, JSON.stringify(unchanged.map((c) => `${c.type}:${[...c.path].length}`)));
	fs.writeFileSync(path.join(Iroot, nfd), "폰에서 고친 회의록\n");
	const I2 = new IsoBackend(new ObsidianFs(iAd as any), nodeHttp, cfg("iPhone"));
	const edited = await I2.changes();
	check("nfd on disk: edit shows one modified file", edited.length === 1 && edited[0].type === "modified" && edited[0].path === nfc, JSON.stringify(edited.map((c) => `${c.type}:${[...c.path].length}`)));
	await I2.stage([nfc]);
	const stagedNfd = await I2.changes();
	check("nfd on disk: staging sticks", stagedNfd.length === 1 && stagedNfd[0].path === nfc && stagedNfd[0].staged && !stagedNfd[0].unstaged, JSON.stringify(stagedNfd.map((c) => [c.type, c.staged, c.unstaged])));
	const nStaged = await I2.commit("nfd staged", true);
	check("nfd on disk: staged commit includes it", nStaged === 1 && (await I2.changes()).length === 0, `n=${nStaged}`);
	await sync(I2, "nfd edit");
	const names = sh(bare, "-c", "core.quotepath=off", "ls-tree", "-r", "--name-only", "-z", "main").split("\0");
	check("nfd on disk: remote keeps one file with the same name", names.includes(nfc) && !names.includes(nfd) && remoteRead(nfc) === "폰에서 고친 회의록\n", JSON.stringify({ nfc: names.includes(nfc), nfd: names.includes(nfd) }));

	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} FAILED` : "\nRESILIENCE PASSED");
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
