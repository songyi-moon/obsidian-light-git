import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import nodeHttp from "isomorphic-git/http/node";
import * as git from "isomorphic-git";
import { CountingAdapter, MockAdapter } from "./mockAdapter";
import { startGitServer } from "./gitServer";
import { ObsidianFs } from "../src/git/obsidianFs";
import { IsoBackend } from "../src/git/isoBackend";
import { friendlyError, gitHttpUrl, remoteUrlProblem } from "../src/git/errors";
import { NativeBackend } from "../src/git/nativeBackend";
import { conflictCopyOriginal, isNewConflictCopy, type GitBackend, type GitConfig } from "../src/git/types";
import { runMergeModelTests } from "./mergeModel.test";
import { acceptAll, apply, buildRegions, mergedText } from "../src/merge/mergeModel";

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

async function sync(b: GitBackend, msg: string) {
	const n = await b.commit(msg);
	const conflicts = await b.pull();
	if (!conflicts.length) await b.push();
	return { n, conflicts };
}

async function main() {
	console.log("— merge model —");
	runMergeModelTests(check);
	console.log("— git backends —");
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lightgit-"));
	const remoteRoot = path.join(tmp, "remote");
	fs.mkdirSync(remoteRoot);
	execFileSync("git", ["init", "--bare", "-b", "main", path.join(remoteRoot, "vault.git")]);
	sh(path.join(remoteRoot, "vault.git"), "config", "http.receivepack", "true");
	sh(path.join(remoteRoot, "vault.git"), "config", "uploadpack.allowFilter", "true"); // GitHub처럼 partial clone 허용
	const server = await startGitServer(remoteRoot);

	const cfg = (name: string): (() => GitConfig) => () => ({
		remoteUrl: `${server.url}/vault.git`,
		branch: "main",
		username: "",
		token: "",
		authorName: name,
		authorEmail: `${name}@test`,
		chunkBytes: 5 * 1024 * 1024,
	});
	const isoDevice = (name: string) => {
		const root = path.join(tmp, name);
		fs.mkdirSync(root);
		return { root, b: new IsoBackend(new ObsidianFs(new MockAdapter(root) as any), nodeHttp, cfg(name)) };
	};

	// 1. 기기 A: 큰 vault를 빈 원격에 처음 올림 → 분할 커밋/분할 push
	const A = isoDevice("A");
	write(A.root, ".obsidian/app.json", "{}");
	write(A.root, "notes/hello.md", "line1\nline2\nline3\n");
	for (let i = 0; i < 12; i++) write(A.root, `assets/img${i}.bin`, require("crypto").randomBytes(1024 * 1024));
	const msg1 = await A.b.connect();
	check("A connect on empty remote", msg1.includes("비어"), msg1);
	const before = server.requests.length;
	const r1 = await sync(A.b, "initial");
	check("A initial commit split into chunks", r1.n === 3, `commits=${r1.n}`);
	const posts = server.requests.slice(before).filter((r) => r.path.endsWith("git-receive-pack"));
	const maxPost = Math.max(...posts.map((p) => p.bytes));
	check("each push body ≤ ~chunk size", maxPost < 6.5 * 1024 * 1024, `pushes=${posts.length}, max=${(maxPost / 1048576).toFixed(1)}MB`);
	const bare = path.join(remoteRoot, "vault.git");
	check("remote has 3 commits", sh(bare, "rev-list", "--count", "main").trim() === "3");
	check("remote has only main branch", sh(bare, "branch").trim() === "* main", sh(bare, "branch").trim());
	check("A status clean after sync", (await A.b.changes()).length === 0);

	// 2. 기기 B (iOS 가정): 빈 vault에서 connect → 원격 내용 받기
	const B = isoDevice("B");
	write(B.root, ".obsidian/app.json", '{"local":true}');
	const beforeB = server.requests.length;
	const msg2 = await B.b.connect();
	check("B connect pulls remote", fs.existsSync(path.join(B.root, "notes/hello.md")), msg2);
	const fetchRes = server.requests.slice(beforeB).filter((r) => r.path.endsWith("git-upload-pack"));
	check("B clone fetched blobs in batches", fetchRes.length >= 4, `upload-pack POSTs=${fetchRes.length}`);
	// 작은 .md를 먼저 받고 나서 1MB 파일들을 한꺼번에 몰아 요청하면 안 된다 (0.1.1에서 앱이 꺼진 원인)
	const maxRes = Math.max(...fetchRes.map((r) => r.resBytes));
	check("B clone each response ≤ ~chunk size", maxRes < 6.5 * 1024 * 1024, `max=${(maxRes / 1048576).toFixed(1)}MB`);
	check("B clone files intact", fs.readFileSync(path.join(B.root, "assets/img7.bin")).equals(fs.readFileSync(path.join(A.root, "assets/img7.bin"))));
	const packsLeft = fs.readdirSync(path.join(B.root, ".git/objects/pack")).filter((f) => f.endsWith(".pack")).length;
	check("B clone keeps only the tree pack", packsLeft === 1, `packs=${packsLeft}`);
	check("B clone is shallow", fs.existsSync(path.join(B.root, ".git/shallow")));
	check("B status clean", (await B.b.changes()).length === 0, JSON.stringify(await B.b.changes()));
	// shallow clone에서 작은 파일 하나 push → 트리 전체(12MB)가 아니라 변경분만 보내야 한다 (iPhone에서 1개 커밋 후 꺼진 원인 후보)
	write(B.root, "notes/small.md", "small\n");
	const beforeSmall = server.requests.length;
	await sync(B.b, "B small");
	const smallPush = Math.max(0, ...server.requests.slice(beforeSmall).filter((r) => r.path.endsWith("git-receive-pack")).map((r) => r.bytes));
	check("shallow B: small push sends only the change", smallPush > 0 && smallPush < 64 * 1024, `push=${(smallPush / 1024).toFixed(0)}KB`);

	// 2-1. 기기 X: 원격과 같은 파일이 이미 있는 vault(.git 없음, 예: iCloud로 받아 둔 것)에서 connect
	const X = isoDevice("X");
	fs.cpSync(A.root, X.root, { recursive: true, filter: (src) => !src.includes(`${path.sep}.git`) });
	write(X.root, "notes/hello.md", "local edit\n");
	const beforeC = server.requests.length;
	await X.b.connect();
	const cFetch = server.requests.slice(beforeC).filter((r) => r.path.endsWith("git-upload-pack")).reduce((s, r) => s + r.resBytes, 0);
	check("existing vault: same files are not downloaded again", cFetch < 1024 * 1024, `fetched=${(cFetch / 1024).toFixed(0)}KB`);
	// .git 기록이 없어 어느 쪽이 최신인지 모름 → 원격 최신본을 쓰고, 볼트 내용은 충돌 사본으로 보관 (옛 파일로 원격을 덮어쓰지 않게)
	const xCopy = fs.readdirSync(path.join(X.root, "notes")).find((f) => f.startsWith("hello (충돌 사본"));
	check("existing vault: differing file → remote content + conflict copy", read(X.root, "notes/hello.md") === read(A.root, "notes/hello.md") && !!xCopy && read(X.root, `notes/${xCopy}`) === "local edit\n", String(xCopy));
	check("existing vault: missing file written", fs.existsSync(path.join(X.root, "notes/small.md")));
	const cChanges = (await X.b.changes()).map((c) => `${c.type}:${c.path}`);
	check("existing vault: only the conflict copy shows", JSON.stringify(cChanges) === JSON.stringify([`added:notes/${xCopy}`]), JSON.stringify(cChanges));
	fs.unlinkSync(path.join(X.root, `notes/${xCopy}`));
	await A.b.pull();

	// 3. 서로 다른 파일 수정 → 자동 병합
	write(A.root, "notes/a.md", "from A\n");
	await sync(A.b, "A edit");
	write(B.root, "notes/b.md", "from B\n");
	const beforeR3 = server.requests.length;
	const r3 = await sync(B.b, "B edit");
	check("B merges A's change cleanly", r3.conflicts.length === 0 && fs.existsSync(path.join(B.root, "notes/a.md")));
	// 로컬 커밋 뒤 pull: 원격이 공통 지점을 알아야 변경분만 온다 (isomorphic-git fetch는 트리 전체 12MB를 받아 iPhone이 꺼졌다)
	const r3Fetch = Math.max(0, ...server.requests.slice(beforeR3).filter((r) => r.path.endsWith("git-upload-pack")).map((r) => r.resBytes));
	check("B pull after local commit fetches only new objects", r3Fetch < 64 * 1024, `max fetch=${(r3Fetch / 1024).toFixed(0)}KB`);
	await A.b.pull();
	check("A receives B's change", fs.existsSync(path.join(A.root, "notes/b.md")));

	// 4. 같은 줄 수정 → 충돌 → 해결 → 머지 커밋
	write(A.root, "notes/hello.md", "line1\nA version\nline3\n");
	await sync(A.b, "A conflict side");
	write(B.root, "notes/hello.md", "line1\nB version\nline3\n");
	const r4 = await sync(B.b, "B conflict side");
	check("B detects conflict", r4.conflicts.includes("notes/hello.md"), JSON.stringify(r4.conflicts));
	check("conflict markers written", read(B.root, "notes/hello.md").includes("<<<<<<<"));
	check("conflicts() lists unresolved", (await B.b.conflicts()).length === 1);
	let threw = false;
	try {
		await B.b.commit("too early");
	} catch {
		threw = true;
	}
	check("commit blocked while unresolved", threw);
	const v = await B.b.conflictVersions("notes/hello.md");
	check("iso conflictVersions base/ours/theirs", v.base === "line1\nline2\nline3\n" && v.ours === "line1\nB version\nline3\n" && v.theirs === "line1\nA version\nline3\n", JSON.stringify(v));
	// 머지 화면에서 하는 일: 원격(A) 적용 → 내 것(B) 적용 → 저장 → 해결 표시
	const regions = buildRegions(v.base!, v.ours!, v.theirs!);
	const conflictRegion = regions.find((x) => x.kind === "conflict")!;
	apply(conflictRegion, "theirs");
	apply(conflictRegion, "ours");
	write(B.root, "notes/hello.md", mergedText(regions));
	await B.b.markResolved("notes/hello.md");
	const r4b = await sync(B.b, "merge resolved");
	check("resolved merge committed + pushed", r4b.n === 1 && r4b.conflicts.length === 0);
	// iso는 로컬 머지 커밋을 원격 tip 위로 다시 쌓아(linearize) fast-forward로 올린다
	const parents = sh(bare, "log", "-1", "--format=%P", "main").trim().split(" ");
	check("iso pushes resolved merge linearly", parents.length === 1 && sh(bare, "show", "main:notes/hello.md") === "line1\nA version\nB version\nline3\n");
	check("B HEAD == remote after linearize", sh(B.root, "rev-parse", "HEAD").trim() === sh(bare, "rev-parse", "main").trim() && (await B.b.changes()).length === 0);
	await A.b.pull();
	check("A gets resolved content", read(A.root, "notes/hello.md") === "line1\nA version\nB version\nline3\n");

	// 5. 네이티브 git(데스크톱)과 상호운용
	const Croot = path.join(tmp, "C");
	fs.mkdirSync(Croot);
	const C = new NativeBackend(Croot, cfg("C"));
	await C.connect();
	check("native C connect gets files", fs.existsSync(path.join(Croot, "notes/a.md")));
	write(Croot, "notes/c.md", "from native\n");
	fs.unlinkSync(path.join(Croot, "notes/a.md"));
	await sync(C, "native edit");
	await A.b.pull();
	check("iso A receives native add+delete", fs.existsSync(path.join(A.root, "notes/c.md")) && !fs.existsSync(path.join(A.root, "notes/a.md")));

	// 6. status 성능: 변경 없는 vault에서 재해시가 일어나지 않는지 (파일 300개)
	for (let i = 0; i < 300; i++) write(A.root, `many/n${i}.md`, `note ${i}\n`);
	await sync(A.b, "many");
	const t0 = Date.now();
	const ch = await A.b.changes();
	check("status on 300+ files clean & fast", ch.length === 0, `${Date.now() - t0}ms`);

	// 7. native 쪽 충돌 → 머지 모델로 해결
	write(A.root, "notes/c.md", "A\n");
	await sync(A.b, "A edits c");
	write(Croot, "notes/c.md", "C\n");
	const r7 = await sync(C, "C edits c");
	check("native detects conflict", r7.conflicts.includes("notes/c.md"), JSON.stringify(r7.conflicts));
	const cv = await C.conflictVersions("notes/c.md");
	check("native conflictVersions", cv.base === "from native\n" && cv.ours === "C\n" && cv.theirs === "A\n", JSON.stringify(cv));
	const cr = buildRegions(cv.base!, cv.ours!, cv.theirs!);
	acceptAll(cr, "theirs");
	write(Croot, "notes/c.md", mergedText(cr));
	await C.markResolved("notes/c.md");
	const r7b = await sync(C, "C resolved");
	check("native resolved merge pushed", r7b.conflicts.length === 0 && sh(bare, "log", "-1", "--format=%P", "main").trim().split(" ").length === 2);
	await A.b.pull();
	check("A gets native resolution", read(A.root, "notes/c.md") === "A\n");

	// 8. 삭제 vs 수정 충돌 (iso): 마커가 없으므로 markResolved 전까지 미해결이어야 함
	await B.b.pull();
	fs.unlinkSync(path.join(A.root, "notes/b.md"));
	await sync(A.b, "A deletes b");
	write(B.root, "notes/b.md", "B keeps editing\n");
	const r8 = await sync(B.b, "B edits b");
	check("delete/modify conflict detected", r8.conflicts.includes("notes/b.md"), JSON.stringify(r8.conflicts));
	const bv = await B.b.conflictVersions("notes/b.md");
	check("delete side is null", bv.theirs === null && bv.ours === "B keeps editing\n", JSON.stringify(bv));
	check("markerless conflict stays unresolved", (await B.b.conflicts()).includes("notes/b.md"));
	write(B.root, "notes/b.md", bv.ours!);
	await B.b.markResolved("notes/b.md");
	const r8b = await sync(B.b, "keep b");
	check("kept file after delete conflict", r8b.conflicts.length === 0 && sh(bare, "show", "main:notes/b.md") === "B keeps editing\n");

	// 9. discard / readAt / log / commitFiles
	await A.b.pull();
	write(A.root, "notes/hello.md", "garbage\n");
	write(A.root, "notes/new.md", "new\n");
	fs.unlinkSync(path.join(A.root, "notes/c.md"));
	for (const c of await A.b.changes()) await A.b.discard(c.path);
	check("iso discard restores everything", (await A.b.changes()).length === 0 && read(A.root, "notes/c.md") === "A\n" && !fs.existsSync(path.join(A.root, "notes/new.md")));
	write(Croot, "notes/hello.md", "garbage\n");
	write(Croot, "notes/new.md", "new\n");
	for (const c of await C.changes()) await C.discard(c.path);
	check("native discard restores everything", (await C.changes()).length === 0 && !fs.existsSync(path.join(Croot, "notes/new.md")));
	check("readAt HEAD", (await A.b.readAt("HEAD", "notes/hello.md")) === read(A.root, "notes/hello.md"));
	const logA = await A.b.log(50);
	const logC = await C.log(50);
	check("iso log newest first", logA[0].oid === sh(A.root, "rev-parse", "HEAD").trim(), logA.slice(0, 3).map((l) => l.message).join(" | "));
	check("native log newest first", logC.length > 0 && logC[0].oid === sh(Croot, "rev-parse", "HEAD").trim());
	const many = logA.find((l) => l.message === "many")!;
	const filesIso = await A.b.commitFiles(many.oid);
	await C.pull();
	const filesNative = await C.commitFiles(many.oid);
	check("commitFiles iso == native", filesIso.length === 300 && filesNative.length === 300 && filesIso.every((f) => f.type === "added"), `iso=${filesIso.length} native=${filesNative.length}`);
	const delCommit = logA.find((l) => l.message === "A deletes b")!;
	const delFiles = await A.b.commitFiles(delCommit.oid);
	check("commitFiles shows deletion", delFiles.length === 1 && delFiles[0].type === "deleted" && delFiles[0].path === "notes/b.md", JSON.stringify(delFiles));

	// 10. 원격과 갈라진 상태에서 대용량 push (iso): 히스토리 전체를 다시 보내지 않고, 분할 push 되어야 함
	await A.b.pull();
	await B.b.pull();
	write(B.root, "notes/from-b.md", "B was here\n");
	await sync(B.b, "B small");
	const remoteBefore = sh(bare, "rev-parse", "main").trim();
	for (let i = 0; i < 8; i++) write(A.root, `big/v${i}.bin`, require("crypto").randomBytes(1024 * 1024));
	const before10 = server.requests.length;
	const r10 = await sync(A.b, "A big while diverged");
	const posts10 = server.requests.slice(before10).filter((r) => r.path.endsWith("git-receive-pack"));
	const max10 = Math.max(...posts10.map((p) => p.bytes));
	check("diverged: no conflict", r10.conflicts.length === 0);
	check("diverged: each push ≤ ~chunk size", max10 < 6.5 * 1024 * 1024, `pushes=${posts10.length}, max=${(max10 / 1048576).toFixed(1)}MB`);
	check("diverged: remote == A HEAD", sh(bare, "rev-parse", "main").trim() === sh(A.root, "rev-parse", "HEAD").trim());
	check("diverged: remote has both sides", sh(bare, "show", "main:notes/from-b.md") === "B was here\n" && sh(bare, "ls-tree", "--name-only", "main", "big/").split("\n").filter(Boolean).length === 8);
	check("diverged: A clean", (await A.b.changes()).length === 0, JSON.stringify(await A.b.changes()));
	await B.b.pull();
	check("diverged: B gets A's files", fs.existsSync(path.join(B.root, "big/v7.bin")) && (await B.b.changes()).length === 0);
	void remoteBefore;

	// 11. staging (iso): 고른 파일만 커밋, 일부만 스테이징한 파일은 스테이징 시점 내용으로
	const st = (ch: { path: string; staged: boolean; unstaged: boolean }[], p: string) => ch.find((c) => c.path === p);
	write(A.root, "notes/s1.md", "s1\n");
	write(A.root, "notes/s2.md", "s2\n");
	await A.b.stage(["notes/s1.md"]);
	let chA = await A.b.changes();
	check("iso stage flags", st(chA, "notes/s1.md")?.staged === true && st(chA, "notes/s1.md")?.unstaged === false && st(chA, "notes/s2.md")?.staged === false && st(chA, "notes/s2.md")?.unstaged === true, JSON.stringify(chA));
	await A.b.stage(["notes/s2.md"]);
	write(A.root, "notes/s2.md", "s2 edited later\n");
	chA = await A.b.changes();
	check("iso partial staging = staged + unstaged", !!st(chA, "notes/s2.md")?.staged && !!st(chA, "notes/s2.md")?.unstaged);
	await A.b.unstage(["notes/s1.md"]);
	check("iso unstage", st(await A.b.changes(), "notes/s1.md")?.staged === false);
	await A.b.stage(["notes/s1.md"]);
	fs.unlinkSync(path.join(A.root, "notes/from-b.md"));
	await A.b.stage(["notes/from-b.md"]);
	write(A.root, "notes/unrelated.md", "not staged\n");
	const n11 = await A.b.commit("staged only", true);
	const files11 = (await A.b.commitFiles(sh(A.root, "rev-parse", "HEAD").trim())).map((f) => `${f.type}:${f.path}`).sort();
	check("iso stagedOnly commits only staged", n11 === 1 && JSON.stringify(files11) === JSON.stringify(["added:notes/s1.md", "added:notes/s2.md", "deleted:notes/from-b.md"]), JSON.stringify(files11));
	check("iso commits staged content, keeps later edit", sh(A.root, "show", "HEAD:notes/s2.md") === "s2\n" && read(A.root, "notes/s2.md") === "s2 edited later\n");
	chA = await A.b.changes();
	check("iso unstaged left as-is", chA.length === 2 && chA.every((c) => !c.staged && c.unstaged), JSON.stringify(chA));
	// 큰 스테이징 → 분할 커밋, 스테이징 안 한 큰 파일은 제외
	const bigStaged: string[] = [];
	for (let i = 0; i < 7; i++) {
		write(A.root, `big2/w${i}.bin`, require("crypto").randomBytes(1024 * 1024));
		bigStaged.push(`big2/w${i}.bin`);
	}
	write(A.root, "big2/unstaged.bin", require("crypto").randomBytes(1024 * 1024));
	await A.b.stage(bigStaged);
	const n11b = await A.b.commit("staged big", true);
	const inTree = sh(A.root, "ls-tree", "--name-only", "HEAD", "big2/").split("\n").filter(Boolean);
	check("iso stagedOnly is chunked", n11b === 2 && inTree.length === 7 && !inTree.includes("big2/unstaged.bin"), `commits=${n11b} files=${inTree.length}`);
	await A.b.pull();
	await A.b.push();
	check("iso push with unstaged changes", sh(bare, "rev-parse", "main").trim() === sh(A.root, "rev-parse", "HEAD").trim());
	// 원격이 A가 커밋 안 한 파일을 바꿈 → pull 거부, 아무것도 안 바뀜
	await B.b.pull();
	write(B.root, "notes/s2.md", "B edit\n");
	write(B.root, "notes/b-only.md", "b only\n");
	await sync(B.b, "B touches s2");
	const headBefore = sh(A.root, "rev-parse", "HEAD").trim();
	let pullErr = "";
	try {
		await A.b.pull();
	} catch (e) {
		pullErr = String(e);
	}
	check("iso pull refuses overlap with uncommitted", pullErr.includes("notes/s2.md") && sh(A.root, "rev-parse", "HEAD").trim() === headBefore && read(A.root, "notes/s2.md") === "s2 edited later\n", pullErr);
	await A.b.discard("notes/s2.md");
	const pc = await A.b.pull();
	check("iso pull keeps unrelated uncommitted files", pc.length === 0 && read(A.root, "notes/b-only.md") === "b only\n" && read(A.root, "notes/s2.md") === "B edit\n" && read(A.root, "notes/unrelated.md") === "not staged\n");
	chA = await A.b.changes();
	check("iso status after pull = only uncommitted", JSON.stringify(chA.map((c) => c.path).sort()) === JSON.stringify(["big2/unstaged.bin", "notes/unrelated.md"]), JSON.stringify(chA));

	// 12. staging (native)
	await C.pull();
	write(Croot, "notes/n1.md", "n1\n");
	write(Croot, "notes/n2.md", "n2\n");
	await C.stage(["notes/n1.md", "notes/n2.md"]);
	await C.unstage(["notes/n2.md"]);
	const chC = await C.changes();
	check("native stage/unstage flags", st(chC, "notes/n1.md")?.staged === true && st(chC, "notes/n2.md")?.staged === false && st(chC, "notes/n2.md")?.unstaged === true, JSON.stringify(chC));
	const nC = await C.commit("native staged", true);
	const filesC = await C.commitFiles(sh(Croot, "rev-parse", "HEAD").trim());
	check("native stagedOnly commits only staged", nC === 1 && filesC.length === 1 && filesC[0].path === "notes/n1.md" && st(await C.changes(), "notes/n2.md")?.unstaged === true, JSON.stringify(filesC));

	// 12-1. 충돌 사본은 커밋에서 빠진다. 스테이징돼 있어도 마찬가지. 이미 커밋된 사본의 삭제는 올라간다
	check("copy names", isNewConflictCopy({ path: "a/b (충돌 사본 2026-11-04 1530) 2.md", type: "added" }) && !isNewConflictCopy({ path: "a/b (충돌 사본 2026-11-04 1530).md", type: "deleted" }) && !isNewConflictCopy({ path: "a/충돌 사본.md", type: "added" }) && conflictCopyOriginal("a/b.c (충돌 사본 2026-11-04 1530) 2.md") === "a/b.c.md" && conflictCopyOriginal("a/b (충돌 사본 2026-11-04 1530)") === "a/b");
	const copyN = "notes/n3 (충돌 사본 2026-11-04 1530).md";
	await C.commit("n2");
	write(Croot, copyN, "copy\n");
	const nCopyOnly = await C.commit("only copy");
	check("native copy: nothing else to commit → no commit", nCopyOnly === 0 && (await C.changes()).some((c) => c.path === copyN && c.type === "added"));
	await C.stage([copyN]);
	write(Croot, "notes/n4.md", "n4\n");
	await C.commit("with copy");
	const treeC = sh(Croot, "ls-tree", "-r", "--name-only", "-z", "HEAD");
	check("native copy: never committed, even when staged", !treeC.includes("충돌 사본") && treeC.includes("notes/n4.md") && st(await C.changes(), copyN)?.staged === false, JSON.stringify(await C.changes()));
	sh(Croot, "add", "-f", "--", copyN);
	sh(Croot, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "old copy");
	fs.unlinkSync(path.join(Croot, copyN));
	const delCopy = await C.commit("remove old copy");
	check("native copy: deleting an already-committed copy is committed", delCopy === 1 && !sh(Croot, "ls-tree", "-r", "--name-only", "-z", "HEAD").includes("충돌 사본"));
	await C.pull();
	await C.push();

	await A.b.pull();
	const copyA = "notes/a3 (충돌 사본 2026-11-04 1530).md";
	write(A.root, copyA, "copy\n");
	write(A.root, "notes/a3.md", "a3\n");
	await A.b.stage([copyA, "notes/a3.md"]);
	const nA = await A.b.commit("staged with copy", true);
	const treeA = sh(A.root, "ls-tree", "-r", "--name-only", "-z", "HEAD");
	check("iso copy: never committed, even when staged", nA === 1 && !treeA.includes("충돌 사본") && treeA.includes("notes/a3.md") && st(await A.b.changes(), copyA)?.staged === false, JSON.stringify(await A.b.changes()));
	await A.b.discard(copyA);
	check("iso copy: discard deletes the copy", !fs.existsSync(path.join(A.root, copyA)));
	await A.b.push();

	// 12-2. 올리지 않은 커밋 수
	const unpushedFlow = async (name: string, me: GitBackend, root: string, other: GitBackend, otherRoot: string) => {
		await other.pull();
		await me.pull();
		await me.push();
		check(`${name} unpushed: 0 when synced`, (await me.unpushedCount()) === 0);
		for (const i of [1, 2]) {
			write(root, `notes/${name}-u${i}.md`, "u\n");
			await me.stage([`notes/${name}-u${i}.md`]);
			await me.commit(`u${i}`, true);
		}
		check(`${name} unpushed: counts local commits`, (await me.unpushedCount()) === 2);
		const unpushedOids = await me.unpushedCommits();
		const recent = (await me.log(2)).map((c) => c.oid);
		check(`${name} unpushed: lists those commits`, unpushedOids.length === 2 && recent.every((o) => unpushedOids.includes(o)));
		await me.push();
		check(`${name} unpushed: 0 after push`, (await me.unpushedCount()) === 0);
		// 갈라진 뒤 머지: 내 커밋 + 머지 커밋
		await other.pull();
		write(root, `notes/${name}-mine.md`, "m\n");
		await me.stage([`notes/${name}-mine.md`]);
		await me.commit("mine", true);
		write(otherRoot, `notes/${name}-theirs.md`, "t\n");
		await other.stage([`notes/${name}-theirs.md`]);
		await other.commit("theirs", true);
		await other.push();
		check(`${name} unpushed: remote change alone doesn't count`, (await me.unpushedCount()) === 1);
		check(`${name} unpushed: merge has no conflicts`, (await me.pull()).length === 0);
		const merged = await me.unpushedCount();
		check(`${name} unpushed: own commit + merge`, merged === 2, `count=${merged}`);
		const mergeLog = await me.log(10);
		const mergeOids = await me.unpushedCommits();
		check(`${name} unpushed: remote commit isn't marked`, !mergeOids.includes(mergeLog.find((c) => c.message === "theirs")?.oid ?? "") && mergeLog.some((c) => c.message === "theirs"));
		await me.push();
		check(`${name} unpushed: 0 after merged push`, (await me.unpushedCount()) === 0);
	};
	await unpushedFlow("iso", A.b, A.root, C, Croot);
	await unpushedFlow("native", C, Croot, A.b, A.root);
	await unpushedFlow("shallow", B.b, B.root, C, Croot);

	// 12-3. 오류 안내와 연결 확인
	const fe = (raw: string) => friendlyError(raw);
	check("errors: auth goes to settings", fe("git-upload-pack HTTP 401").settings && fe("HTTP Error: 403 Forbidden").settings && fe("fatal: Authentication failed for 'https://x'").message.startsWith("인증"));
	check("errors: repo not found", fe("remote: Repository not found.").message.startsWith("저장소를 찾을 수") && fe("HTTP Error: 404 Not Found").settings);
	check("errors: network has no settings button", fe("net::ERR_INTERNET_DISCONNECTED").message.startsWith("네트워크") && !fe("The Internet connection appears to be offline.").settings && fe("fatal: Could not resolve host: github.com").message.startsWith("네트워크"));
	check("errors: rejected push", fe("! [rejected] main -> main (fetch first)").message.includes("먼저 pull"));
	const ownMsg = "커밋하지 않은 변경이 원격에서 바뀐 파일과 겹칩니다. 먼저 커밋하거나 되돌리세요: notes/network 401.md";
	check("errors: own Korean messages and unknown errors stay as they are", fe(ownMsg).message === ownMsg && !fe(ownMsg).settings && fe("something odd").message === "something odd");
	check("url check", remoteUrlProblem("", false) !== null && remoteUrlProblem("https://github.com/a/b.git", true) === null && remoteUrlProblem("git@github.com:a/b.git", true) !== null && remoteUrlProblem("git@github.com:a/b.git", false) === null && remoteUrlProblem("github.com/a/b", false) !== null && remoteUrlProblem("https://a b", true) !== null);
	const urlCases: [string, string][] = [
		["https://gitlab.co.kr/group/sub/vault", "https://gitlab.co.kr/group/sub/vault.git"],
		["http://10.0.0.5:8080/group/vault/", "http://10.0.0.5:8080/group/vault.git"],
		["https://github.com/a/b.git", "https://github.com/a/b.git"],
		["https://github.com/a/b.GIT", "https://github.com/a/b.GIT"],
		["https://dev.azure.com/org/proj/_git/vault", "https://dev.azure.com/org/proj/_git/vault"],
		["https://git-codecommit.ap-northeast-2.amazonaws.com/v1/repos/vault", "https://git-codecommit.ap-northeast-2.amazonaws.com/v1/repos/vault"],
		["git@gitlab.co.kr:group/vault", "git@gitlab.co.kr:group/vault"],
		["ssh://git@gitlab.co.kr/group/vault", "ssh://git@gitlab.co.kr/group/vault"],
		["https://gitlab.co.kr", "https://gitlab.co.kr"],
		["https://gitlab.co.kr/", "https://gitlab.co.kr/"],
		["", ""],
	];
	const urlWrong = urlCases.filter(([url, want]) => gitHttpUrl(url) !== want);
	check("git http url: adds .git only where it belongs", urlWrong.length === 0, JSON.stringify(urlWrong));
	const withBranch = (branch: string, repo = "vault"): (() => GitConfig) => () => ({ ...cfg("check")(), branch, remoteUrl: `${server.url}/${repo}.git` });
	const checkDir = path.join(tmp, "check");
	fs.mkdirSync(checkDir);
	const isoCheck = (c: () => GitConfig) => new IsoBackend(new ObsidianFs(new MockAdapter(checkDir) as any), nodeHttp, c);
	const noSuffix = () => ({ ...cfg("check")(), branch: "main", remoteUrl: `${server.url}/vault` });
	check("iso: URL without .git still reaches the repo", await isoCheck(noSuffix).checkRemote());
	const nativeCheck = (c: () => GitConfig) => new NativeBackend(checkDir, c);
	for (const [name, make] of [["iso", isoCheck], ["native", nativeCheck]] as const) {
		const has = await make(withBranch("main")).checkRemote();
		const hasNot = await make(withBranch("no-such-branch")).checkRemote();
		const failure = await make(withBranch("main", "missing")).checkRemote().then(() => "no error", (e) => String(e?.message ?? e));
		check(`${name} checkRemote: finds branch, reports missing branch, missing repo gets a clear message`, has && !hasNot && fe(failure).message.startsWith("저장소를 찾을 수"), failure.split("\n")[0]);
	}
	check("checkRemote leaves the folder untouched", fs.readdirSync(checkDir).length === 0);

	// 12-1. 줄바꿈·BOM만 달라진 파일: 편집기가 다시 저장해도 변경이 아니다
	console.log("— 줄바꿈·BOM만 달라진 파일 —");
	const eolBare = path.join(remoteRoot, "eol.git");
	execFileSync("git", ["init", "--bare", "-b", "main", eolBare]);
	sh(eolBare, "config", "http.receivepack", "true");
	sh(eolBare, "config", "uploadpack.allowFilter", "true");
	const eolSeed = path.join(tmp, "eolSeed");
	fs.mkdirSync(eolSeed);
	sh(eolSeed, "init", "-b", "main");
	sh(eolSeed, "config", "core.autocrlf", "false");
	sh(eolSeed, "config", "user.name", "seed");
	sh(eolSeed, "config", "user.email", "seed@test");
	const BOM = "\uFEFF";
	write(eolSeed, "crlf.md", "a\r\nb\r\n");
	write(eolSeed, "bom.md", BOM + "a\nb\n");
	write(eolSeed, "real.md", "a\r\nb\r\n");
	write(eolSeed, "remote.md", "x\r\ny\r\n");
	write(eolSeed, "bin.dat", Buffer.from([0, 13, 10, 1]));
	sh(eolSeed, "add", "-A");
	sh(eolSeed, "commit", "-m", "seed");
	sh(eolSeed, "push", eolBare, "main");
	const eolCfg = (name: string) => () => ({ ...cfg(name)(), remoteUrl: `${server.url}/eol.git` });
	const rewrite = (root: string) => {
		write(root, "crlf.md", "a\nb\n");
		write(root, "bom.md", "a\nb\n");
		write(root, "real.md", "a \nb\n");
		write(root, "remote.md", "x\ny\n");
		write(root, "bin.dat", Buffer.from([0, 10, 1]));
	};
	const remoteEdit = (file: string, text: string) => {
		sh(eolSeed, "pull", "-q", "--no-rebase", "--no-edit", eolBare, "main");
		write(eolSeed, file, text);
		sh(eolSeed, "add", "-A");
		sh(eolSeed, "commit", "-m", `remote ${file}`);
		sh(eolSeed, "push", eolBare, "main");
	};
	const names = (c: { path: string }[]) => c.map((x) => x.path).sort().join();
	const blob = (root: string, p: string) => execFileSync("git", ["show", `HEAD:${p}`], { cwd: root });

	const nativeEol = path.join(tmp, "nativeEol");
	execFileSync("git", ["clone", "-q", eolBare, nativeEol]);
	sh(nativeEol, "config", "user.name", "n");
	sh(nativeEol, "config", "user.email", "n@test");
	const N = new NativeBackend(nativeEol, eolCfg("n"));
	rewrite(nativeEol);
	check("native eol: git itself reports them (the bug being fixed)", ["crlf.md", "bom.md", "remote.md"].every((p) => sh(nativeEol, "status", "--porcelain").includes(p)), sh(nativeEol, "status", "--porcelain"));
	check("native eol: only real edits and binary stay listed", names(await N.changes()) === "bin.dat,real.md", names(await N.changes()));
	write(nativeEol, "bin.dat", Buffer.from([0, 13, 10, 1]));
	await N.commit("real only");
	check("native eol: commit leaves them out", blob(nativeEol, "crlf.md").includes(13) && blob(nativeEol, "bom.md")[0] === 0xef && !blob(nativeEol, "real.md").includes(13), sh(nativeEol, "show", "--name-only", "--format=", "HEAD"));
	check("native eol: nothing left to commit", (await N.commit("again")) === 0);
	await N.push();
	remoteEdit("remote.md", "x\r\ny\r\nz\r\n");
	const nPull = await N.pull();
	check("native eol: remote edit of such a file still pulls", nPull.length === 0 && read(nativeEol, "remote.md").includes("z"), read(nativeEol, "remote.md"));
	check("native eol: text is intact afterwards", read(nativeEol, "crlf.md").replace(/\r/g, "") === "a\nb\n" && names(await N.changes()) === "", names(await N.changes()));

	const isoEolRoot = path.join(tmp, "isoEol");
	fs.mkdirSync(isoEolRoot);
	const I = new IsoBackend(new ObsidianFs(new MockAdapter(isoEolRoot) as any), nodeHttp, eolCfg("i"));
	await I.connect();
	write(isoEolRoot, "crlf.md", "a\nb\n");
	write(isoEolRoot, "bom.md", "a\nb\n");
	write(isoEolRoot, "remote.md", "x\ny\nz\n");
	write(isoEolRoot, "real.md", "a  \nb\n");
	check("iso eol: only real edits stay listed", names(await I.changes()) === "real.md", names(await I.changes()));
	check("iso eol: commit leaves them out", (await I.commit("real only")) === 1 && names(await I.changes()) === "");
	await I.push();
	remoteEdit("crlf.md", "a\r\nb\r\nc\r\n");
	const iPull = await I.pull();
	check("iso eol: remote edit of such a file still pulls, no conflict copy", iPull.length === 0 && read(isoEolRoot, "crlf.md").includes("c") && !fs.readdirSync(isoEolRoot).some((f) => f.includes("충돌")), JSON.stringify(fs.readdirSync(isoEolRoot)));

	// 빈 원격: PC에서 처음 올려도 화면 상태 파일이 목록을 채우지 않는다 (사용자가 만든 .gitignore는 그대로)
	const emptyBare = path.join(remoteRoot, "emptyIgnore.git");
	execFileSync("git", ["init", "--bare", "-b", "main", emptyBare]);
	const emptyCfg = () => ({ ...cfg("n")(), remoteUrl: `${server.url}/emptyIgnore.git` });
	const ig1 = path.join(tmp, "ignore1");
	write(ig1, ".obsidian/workspace.json", "{}");
	await new NativeBackend(ig1, emptyCfg).connect();
	check("native empty remote: default .gitignore hides workspace.json", read(ig1, ".gitignore").includes(".obsidian/workspace.json") && !names(await new NativeBackend(ig1, emptyCfg).changes()).includes("workspace"));
	const ig2 = path.join(tmp, "ignore2");
	write(ig2, ".gitignore", "mine\n");
	await new NativeBackend(ig2, emptyCfg).connect();
	check("native empty remote: existing .gitignore is kept", read(ig2, ".gitignore") === "mine\n");

	// 13. 저장소 폴더: vault의 하위 폴더에 clone → 기기별 .obsidian은 git에 안 잡힘
	const vaultD = path.join(tmp, "vaultD");
	write(vaultD, ".obsidian/workspace.json", '{"device":"D"}');
	write(vaultD, "local-only.md", "not in git\n");
	const D = new IsoBackend(new ObsidianFs(new MockAdapter(vaultD) as any, "repo"), nodeHttp, cfg("D"));
	fs.mkdirSync(path.join(vaultD, "repo"));
	check("subfolder: not a repo yet", !(await D.isRepo()));
	await D.connect();
	check("subfolder: iso clones into folder", read(vaultD, "repo/notes/hello.md") === read(A.root, "notes/hello.md") && fs.existsSync(path.join(vaultD, "repo/.git/config")) && !fs.existsSync(path.join(vaultD, ".git")));
	const chD = await D.changes();
	check("subfolder: .obsidian / outside files not tracked", chD.length === 0, JSON.stringify(chD));
	write(vaultD, "repo/notes/from-d.md", "D\n");
	write(vaultD, ".obsidian/workspace.json", '{"device":"D2"}');
	const rD = await sync(D, "D edit");
	check("subfolder: iso sync pushes only repo files", rD.n === 1 && sh(bare, "show", "main:notes/from-d.md") === "D\n" && !sh(bare, "ls-tree", "-r", "--name-only", "main").includes("workspace.json"));
	const fD = await D.commitFiles(sh(path.join(vaultD, "repo"), "rev-parse", "HEAD").trim());
	check("subfolder: repo-relative paths", fD.length === 1 && fD[0].path === "notes/from-d.md", JSON.stringify(fD));
	// native: vault 루트에 예전 .git(obsidian-git)이 있어도 하위 폴더는 별도 저장소로
	const vaultE = path.join(tmp, "vaultE");
	write(vaultE, "old.md", "old\n");
	sh(vaultE, "init", "-q", "-b", "main");
	fs.mkdirSync(path.join(vaultE, "repo"));
	const E = new NativeBackend(path.join(vaultE, "repo"), cfg("E"));
	check("subfolder: parent .git doesn't count as repo", !(await E.isRepo()));
	await E.connect();
	const eFile = fs.existsSync(path.join(vaultE, "repo/notes/from-d.md")) ? read(vaultE, "repo/notes/from-d.md").replace(/\r\n/g, "\n") : null; // Windows autocrlf
	const eChanges = await E.changes();
	check("subfolder: native clones into folder", eFile === "D\n" && (await E.isRepo()) && eChanges.length === 0, JSON.stringify({ eFile, repo: await E.isRepo(), eChanges: eChanges.slice(0, 3) }));

	// 14. iOS에서 obsidian-git을 쓰던 볼트 (isomorphic-git 전체 clone → 히스토리 전체가 pack 하나)
	await A.b.pull();
	await sync(A.b, "before obsidian-git phone");
	const url = `${server.url}/vault.git`;
	const ogClone = async (name: string) => {
		const root = path.join(tmp, name);
		fs.mkdirSync(root);
		await git.clone({ fs, http: nodeHttp, dir: root, url, ref: "main", singleBranch: true });
		const ad = new CountingAdapter(root);
		return { root, ad, b: new IsoBackend(new ObsidianFs(ad as any), nodeHttp, cfg("og")) };
	};
	const og = await ogClone("OG");
	// 폰: push 못 한 obsidian-git 커밋, 커밋 안 한 편집, PC와 같은 파일 편집, 이 플러그인을 켠 플러그인 목록
	write(og.root, "notes/c.md", "phone committed\n");
	await git.add({ fs, dir: og.root, filepath: "notes/c.md" });
	const ogHead = await git.commit({ fs, dir: og.root, message: "vault backup: phone", author: { name: "og", email: "og@t" } });
	write(og.root, "notes/s1.md", "phone uncommitted\n");
	write(og.root, "notes/hello.md", "phone edit\n");
	write(og.root, ".obsidian/community-plugins.json", '["light-git"]');
	// 그 사이 PC가 push
	write(A.root, "notes/hello.md", "pc edit\n");
	write(A.root, "notes/unrelated.md", "pc newer\n");
	write(A.root, "notes/pc-new.md", "pc new\n");
	fs.unlinkSync(path.join(A.root, "notes/b-only.md"));
	write(A.root, ".obsidian/community-plugins.json", '["obsidian-git"]');
	await sync(A.b, "pc after phone");
	og.ad.reset();
	const before14 = server.requests.length;
	const msg14 = await og.b.connect();
	const fetched14 = server.requests.slice(before14).filter((r) => r.path.endsWith("git-upload-pack")).reduce((s, r) => s + r.resBytes, 0);
	check("obsidian-git vault: own repo in .lightgit, old .git ignores it", fs.existsSync(path.join(og.root, ".lightgit/config")) && read(og.root, ".git/info/exclude").includes(".lightgit/"), msg14.split("\n")[0]);
	check("obsidian-git vault: old .git HEAD unchanged", sh(og.root, "rev-parse", "HEAD").trim() === ogHead);
	check("obsidian-git vault: big pack not re-read", og.ad.packReads <= 6, `pack reads=${og.ad.packReads} (${(og.ad.packReadBytes / 1048576).toFixed(1)}MB)`);
	check("obsidian-git vault: index written in batches", og.ad.indexWrites <= 20, `index writes=${og.ad.indexWrites}`);
	check("obsidian-git vault: existing files not downloaded", fetched14 < 1024 * 1024, `fetched=${(fetched14 / 1024).toFixed(0)}KB`);
	check("obsidian-git vault: stale file updated to PC version", read(og.root, "notes/unrelated.md") === "pc newer\n");
	check("obsidian-git vault: PC add/delete applied", read(og.root, "notes/pc-new.md") === "pc new\n" && !fs.existsSync(path.join(og.root, "notes/b-only.md")));
	check("obsidian-git vault: phone-only edits kept", read(og.root, "notes/c.md") === "phone committed\n" && read(og.root, "notes/s1.md") === "phone uncommitted\n");
	const ogCopy = fs.readdirSync(path.join(og.root, "notes")).find((f) => f.startsWith("hello (충돌 사본"));
	check("obsidian-git vault: both-edited file → PC version + conflict copy", read(og.root, "notes/hello.md") === "pc edit\n" && !!ogCopy && read(og.root, `notes/${ogCopy}`) === "phone edit\n", String(ogCopy));
	check("obsidian-git vault: plugin list stays local", read(og.root, ".obsidian/community-plugins.json") === '["light-git"]');
	const ogChanges = (await og.b.changes()).map((c) => `${c.type}:${c.path}`).sort();
	check(
		"obsidian-git vault: changes = phone edits only",
		JSON.stringify(ogChanges) === JSON.stringify([".obsidian/community-plugins.json", `notes/${ogCopy}`, "notes/c.md", "notes/s1.md"].map((p) => (p.includes("충돌") ? `added:${p}` : `modified:${p}`)).sort()),
		JSON.stringify(ogChanges),
	);
	await sync(og.b, "phone first sync");
	check("conflict copy: not pushed, stays on device and in changes", !sh(bare, "ls-tree", "-r", "--name-only", "-z", "main").includes("충돌 사본") && read(og.root, `notes/${ogCopy}`) === "phone edit\n" && (await og.b.changes()).some((c) => c.path === `notes/${ogCopy}`));
	await A.b.pull();
	check("obsidian-git vault: phone sync doesn't revert PC changes", read(A.root, "notes/hello.md") === "pc edit\n" && read(A.root, "notes/unrelated.md") === "pc newer\n" && read(A.root, "notes/c.md") === "phone committed\n");

	// 14-1. 연결 도중 앱이 꺼짐 → 이어서 연결
	const R = await ogClone("R");
	write(A.root, "notes/after-r.md", "after R\n");
	await sync(A.b, "after R clone");
	R.ad.failOn = (p) => p.endsWith("notes/after-r.md");
	let crashed = false;
	try {
		await R.b.connect();
	} catch {
		crashed = true;
	}
	check("resume: interrupted connect leaves a marker", crashed && fs.existsSync(path.join(R.root, ".lightgit/LIGHT_GIT_CLONING")));
	const rejects = async (fn: () => Promise<unknown>) => fn().then(() => false, (e) => String(e).includes("다시 실행"));
	check("resume: pull/commit refused until reconnect", (await rejects(() => R.b.pull())) && (await rejects(() => R.b.commit("x"))));
	R.ad.failOn = null;
	await R.b.connect();
	check("resume: reconnect finishes", read(R.root, "notes/after-r.md") === "after R\n" && !fs.existsSync(path.join(R.root, ".lightgit/LIGHT_GIT_CLONING")) && (await R.b.changes()).length === 0, JSON.stringify(await R.b.changes()));

	// 14-2. 히스토리 전체가 pack인 저장소에서 pull/push: 작업마다 pack을 한 번만 읽어야 한다 (캐시 없을 땐 수십 번)
	const K = await ogClone("K");
	await git.setConfig({ fs, dir: K.root, path: "lightgit.owned", value: "true" });
	write(A.root, "notes/for-k.md", "for K\n");
	await sync(A.b, "for K");
	K.ad.reset();
	await K.b.pull();
	check("packed repo: pull reads pack only a few times", read(K.root, "notes/for-k.md") === "for K\n" && K.ad.packReads <= 4, `pack reads=${K.ad.packReads}`);
	write(K.root, "notes/from-k.md", "K\n");
	K.ad.reset();
	await sync(K.b, "K edit");
	check("packed repo: sync reads pack only a few times", sh(bare, "show", "main:notes/from-k.md") === "K\n" && K.ad.packReads <= 8, `pack reads=${K.ad.packReads}`);

	// 원격이 그대로면 pull이 파일을 하나씩 확인하지 않는다. 새 커밋이 있거나 지난번에 받다 끊겼으면 확인해서 받는다
	const Proot = path.join(tmp, "P");
	fs.mkdirSync(Proot);
	const pAd = new CountingAdapter(Proot);
	const P = new IsoBackend(new ObsidianFs(pAd as any), nodeHttp, cfg("p"));
	await P.connect();
	const remoteFiles = sh(bare, "ls-tree", "-r", "--name-only", "main").trim().split("\n").length;
	pAd.reset();
	await P.pull();
	check("pull unchanged: no per-file checks", remoteFiles > 20 && pAd.objectChecks < 10, `files=${remoteFiles} checks=${pAd.objectChecks}`);
	write(Proot, "notes/from-p.md", "P\n");
	await sync(P, "P edit");
	pAd.reset();
	await P.pull();
	check("pull after own push: no per-file checks", pAd.objectChecks < 10, `checks=${pAd.objectChecks}`);
	const bigFile = (name: string) => {
		const data = require("crypto").randomBytes(200 * 1024);
		write(A.root, name, data);
		return data as Buffer;
	};
	const big1 = bigFile("notes/big-new.bin");
	await sync(A.b, "big new");
	await P.pull();
	check("pull new commit: gets the big file", fs.readFileSync(path.join(Proot, "notes/big-new.bin")).equals(big1) && (await P.changes()).length === 0);
	const big2 = bigFile("notes/big-cut.bin");
	await sync(A.b, "big cut");
	const tipBefore = sh(Proot, "rev-parse", "refs/remotes/origin/main").trim();
	let packWrites = 0;
	pAd.failOn = (p) => p.endsWith(".pack") && ++packWrites > 1; // 커밋·트리는 받았고 큰 파일을 받다가 끊김
	const cut = await P.pull().then(() => false, () => true);
	pAd.failOn = null;
	const newTip = sh(bare, "rev-parse", "main").trim();
	sh(Proot, "cat-file", "-e", newTip);
	check("pull cut off: origin stays behind though the commit arrived", cut && sh(Proot, "rev-parse", "refs/remotes/origin/main").trim() === tipBefore && tipBefore !== newTip);
	await P.pull();
	check("pull after cut off: gets the missing file", fs.readFileSync(path.join(Proot, "notes/big-cut.bin")).equals(big2) && sh(Proot, "rev-parse", "refs/remotes/origin/main").trim() === newTip && (await P.changes()).length === 0, JSON.stringify(await P.changes()));

	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
