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
import type { GitBackend, GitConfig } from "../src/git/types";
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
	const msg2 = await B.b.connect();
	check("B connect pulls remote", fs.existsSync(path.join(B.root, "notes/hello.md")), msg2);
	check("B status clean", (await B.b.changes()).length === 0, JSON.stringify(await B.b.changes()));

	// 3. 서로 다른 파일 수정 → 자동 병합
	write(A.root, "notes/a.md", "from A\n");
	await sync(A.b, "A edit");
	write(B.root, "notes/b.md", "from B\n");
	const r3 = await sync(B.b, "B edit");
	check("B merges A's change cleanly", r3.conflicts.length === 0 && fs.existsSync(path.join(B.root, "notes/a.md")));
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

	server.close();
	fs.rmSync(tmp, { recursive: true, force: true });
	console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED");
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
