import * as git from "isomorphic-git";

/**
 * 큰 저장소를 모바일에서 받기 위한 분할 clone (git protocol v2 partial clone).
 *
 * isomorphic-git의 fetch는 pack 전체를 메모리에 올리므로 1GB 저장소면 iOS가 앱을 죽인다.
 * 1) filter blob:none + depth 1 로 커밋/트리만 받고
 * 2) 파일 내용(blob)은 batchBytes 정도씩 oid로 요청해서 받는다.
 * 받은 묶음은 loose object로 풀고 pack은 지운다 — 남겨 두면 isomorphic-git이 checkout 때 pack을 통째로 메모리에 올린다.
 * 이미 받은 blob은 건너뛰므로 도중에 앱이 꺼져도 다시 연결하면 이어서 받는다.
 */

interface Fs {
	writeFile(path: string, data: string | Uint8Array): Promise<void>;
	unlink(path: string): Promise<void>;
	lstat(path: string): Promise<unknown>;
	mkdir(path: string): Promise<void>;
}

export interface BatchCloneOptions {
	fs: Fs;
	dir: string;
	http: git.HttpClient;
	url: string;
	onAuth: () => { username: string; password: string } | undefined;
	branch: string;
	/** 한 번에 받을 blob 묶음의 목표 크기 */
	batchBytes: number;
	onProgress?: (msg: string) => void;
}

/** 크기를 모르는 blob을 처음엔 1개만 요청하고, 받은 평균 크기로 다음 묶음 개수를 정한다 */
const MAX_WANTS = 500;
const TEXT_RE = /\.(md|txt|canvas|json|csv|ya?ml|css|js|ts|html?|xml|svg|base)$/i;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * 원격 브랜치를 분할로 받아 objects에 저장하고 원격 tip oid를 반환한다.
 * 서버가 protocol v2 filter/shallow를 지원하지 않거나 브랜치가 없으면 null (호출자가 기존 방식으로 받는다).
 */
export async function batchClone(o: BatchCloneOptions): Promise<string | null> {
	if (!(await supportsPartialClone(o))) return null;
	const refs = await git.listServerRefs({ http: o.http, url: o.url, onAuth: o.onAuth, prefix: `refs/heads/${o.branch}` });
	const tip = refs.find((r) => r.ref === `refs/heads/${o.branch}`)?.oid;
	if (!tip) return null;
	const base = { fs: o.fs as unknown as git.FsClient, dir: o.dir };

	// 1) 커밋 + 트리
	o.onProgress?.("Git: 파일 목록 받는 중…");
	const first = parseFetch(await post(o, fetchRequest([tip], ["deepen 1", "filter blob:none"])));
	await ensureDir(o.fs, ".git/objects/pack");
	await storePack(o, first.pack);
	if (first.shallow.length) await o.fs.writeFile(".git/shallow", first.shallow.join("\n") + "\n");

	// 2) 파일 내용
	const all = new Map<string, string>();
	const cache = {};
	const { commit } = await git.readCommit({ ...base, oid: tip, cache });
	await listBlobs(base, commit.tree, "", cache, all);
	// 글 파일과 나머지(이미지·PDF 등)는 크기가 수천 배 차이 나므로 묶음 크기를 따로 잰다
	const text: string[] = [];
	const other: string[] = [];
	for (const [oid, path] of all) {
		if (await exists(o.fs, `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`)) continue;
		(TEXT_RE.test(path) ? text : other).push(oid);
	}

	const total = text.length + other.length;
	let done = 0;
	let doneBytes = 0;
	for (const queue of [text, other]) {
		let count = 1;
		let gotBytes = 0;
		let gotBlobs = 0;
		for (let i = 0; i < queue.length; ) {
			o.onProgress?.(`Git: 받는 중 ${done}/${total}개 (${(doneBytes / 1048576).toFixed(0)}MB)`);
			const batch = queue.slice(i, i + count);
			const { pack } = parseFetch(await post(o, fetchRequest(batch, [])));
			gotBytes += pack.byteLength;
			gotBlobs += batch.length;
			doneBytes += pack.byteLength;
			const packPath = await storePack(o, pack);
			const batchCache = {};
			for (const oid of batch) {
				const { blob } = await git.readBlob({ ...base, oid, cache: batchCache });
				await git.writeBlob({ ...base, blob });
			}
			await o.fs.unlink(packPath);
			await o.fs.unlink(packPath.replace(/\.pack$/, ".idx"));
			i += batch.length;
			done += batch.length;
			// 평균 크기로 다음 개수를 정하되 한 번에 두 배까지만 늘린다 (작은 파일 몇 개만 보고 크게 잡지 않게)
			const fit = Math.floor(o.batchBytes / Math.max(1, gotBytes / gotBlobs));
			count = Math.max(1, Math.min(MAX_WANTS, count * 2, fit));
		}
	}

	await git.writeRef({ ...base, ref: `refs/remotes/origin/${o.branch}`, value: tip, force: true });
	return tip;
}

async function supportsPartialClone(o: BatchCloneOptions): Promise<boolean> {
	const res = await o.http.request({ url: `${o.url}/info/refs?service=git-upload-pack`, method: "GET", headers: headers(o, false) });
	if (res.statusCode !== 200) return false;
	const lines = [...pktLines(await collect(res.body))].filter((p) => p.data).map((p) => dec.decode(p.data!).trim());
	const fetchCap = lines.find((l) => l.startsWith("fetch="));
	return lines.includes("version 2") && !!fetchCap && /\bfilter\b/.test(fetchCap) && /\bshallow\b/.test(fetchCap);
}

function headers(o: BatchCloneOptions, isPost: boolean): Record<string, string> {
	const h: Record<string, string> = { "git-protocol": "version=2" };
	if (isPost) {
		h["content-type"] = "application/x-git-upload-pack-request";
		h["accept"] = "application/x-git-upload-pack-result";
	}
	const auth = o.onAuth();
	if (auth) h["authorization"] = "Basic " + btoa(`${auth.username}:${auth.password}`);
	return h;
}

async function post(o: BatchCloneOptions, body: Uint8Array): Promise<Uint8Array> {
	const res = await o.http.request({ url: `${o.url}/git-upload-pack`, method: "POST", headers: headers(o, true), body: (async function* () {
		yield body;
	})() });
	const data = await collect(res.body);
	if (res.statusCode !== 200) throw new Error(`git-upload-pack HTTP ${res.statusCode}`);
	return data;
}

function fetchRequest(wants: string[], args: string[]): Uint8Array {
	const lines = ["no-progress", "ofs-delta", ...args, ...wants.map((w) => `want ${w}`), "done"];
	return concat([pkt("command=fetch\n"), enc.encode("0001"), ...lines.map((l) => pkt(l + "\n")), enc.encode("0000")]);
}

/** v2 fetch 응답: shallow-info 섹션과 packfile 섹션(sideband)만 사용 */
function parseFetch(buf: Uint8Array): { shallow: string[]; pack: Uint8Array } {
	const shallow: string[] = [];
	const parts: Uint8Array[] = [];
	let section = "";
	for (const p of pktLines(buf)) {
		if (p.type === "flush") break;
		if (p.type === "delim") {
			section = "";
			continue;
		}
		const data = p.data!;
		if (!section) {
			section = dec.decode(data).trim();
			if (section.startsWith("ERR ")) throw new Error(`원격 오류: ${section.slice(4)}`);
			continue;
		}
		if (section === "shallow-info") {
			const [kind, oid] = dec.decode(data).trim().split(" ");
			if (kind === "shallow") shallow.push(oid);
		} else if (section === "packfile") {
			if (data[0] === 1) parts.push(data.subarray(1));
			else if (data[0] === 3) throw new Error(`원격 오류: ${dec.decode(data.subarray(1)).trim()}`);
		}
	}
	if (!parts.length) throw new Error("원격이 packfile을 보내지 않았습니다.");
	return { shallow, pack: concat(parts) };
}

function* pktLines(buf: Uint8Array): Generator<{ type: "flush" | "delim" | "data"; data?: Uint8Array }> {
	let off = 0;
	while (off + 4 <= buf.length) {
		const len = parseInt(dec.decode(buf.subarray(off, off + 4)), 16);
		if (len === 0) yield { type: "flush" };
		else if (len === 1 || len === 2) yield { type: "delim" };
		if (len < 4) {
			off += 4;
			continue;
		}
		yield { type: "data", data: buf.subarray(off + 4, off + len) };
		off += len;
	}
}

/** pack을 pack-<checksum>.pack 으로 저장하고 .idx를 만든다 */
async function storePack(o: BatchCloneOptions, pack: Uint8Array): Promise<string> {
	const sha = [...pack.subarray(pack.length - 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
	const path = `.git/objects/pack/pack-${sha}.pack`;
	await o.fs.writeFile(path, pack);
	await git.indexPack({ fs: o.fs as unknown as git.FsClient, dir: o.dir, filepath: path });
	return path;
}

/** oid → 경로 (같은 내용의 파일이 여럿이면 하나만) */
async function listBlobs(base: { fs: git.FsClient; dir: string }, treeOid: string, prefix: string, cache: object, out: Map<string, string>) {
	const { tree } = await git.readTree({ ...base, oid: treeOid, cache });
	for (const e of tree) {
		if (e.type === "tree") await listBlobs(base, e.oid, `${prefix}${e.path}/`, cache, out);
		else if (e.type === "blob" && !out.has(e.oid)) out.set(e.oid, prefix + e.path);
	}
}

async function ensureDir(fs: Fs, path: string) {
	let cur = "";
	for (const part of path.split("/")) {
		cur = cur ? `${cur}/${part}` : part;
		if (!(await exists(fs, cur))) await fs.mkdir(cur);
	}
}

async function exists(fs: Fs, path: string): Promise<boolean> {
	try {
		await fs.lstat(path);
		return true;
	} catch {
		return false;
	}
}

function pkt(line: string): Uint8Array {
	const body = enc.encode(line);
	return concat([enc.encode((body.length + 4).toString(16).padStart(4, "0")), body]);
}

async function collect(body: AsyncIterableIterator<Uint8Array> | undefined): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	if (body) for await (const c of body) parts.push(c);
	return parts.length === 1 ? parts[0] : concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.byteLength;
	}
	return out;
}
