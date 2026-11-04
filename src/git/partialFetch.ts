import * as git from "isomorphic-git";

/**
 * 모바일에서 큰 저장소를 받기 위한 fetch (git protocol v2 partial fetch). clone과 pull 모두 이걸 쓴다.
 *
 * isomorphic-git의 fetch는 문제가 두 가지다.
 *  - pack 전체를 메모리에 올린다 → 1GB면 iOS가 앱을 죽인다.
 *  - have로 로컬 브랜치 tip 하나만 보낸다 → 로컬 커밋 뒤 pull하면 원격이 공통 지점을 몰라 트리·히스토리 전체를 보낸다.
 * 그래서
 *  1) 원격이 아는 커밋(origin/브랜치와 조상들)을 have로 보내고, filter blob:limit 로 커밋·트리·작은 파일만 한 번에 받고
 *  2) 큰 파일은 하나씩 oid로 받아 loose object로 풀고 pack은 지운다 (남겨 두면 checkout 때 pack을 통째로 메모리에 올린다).
 * 이미 받은 blob은 건너뛰므로 도중에 앱이 꺼져도 다시 하면 이어서 받는다.
 */

interface Fs {
	readFile(path: string, opts?: { encoding?: string }): Promise<string | Uint8Array>;
	writeFile(path: string, data: string | Uint8Array): Promise<void>;
	unlink(path: string): Promise<void>;
	lstat(path: string): Promise<unknown>;
	mkdir(path: string): Promise<void>;
}

export interface PartialFetchOptions {
	fs: Fs;
	dir: string;
	http: git.HttpClient;
	url: string;
	onAuth: () => { username: string; password: string } | undefined;
	branch: string;
	onProgress?: (msg: string) => void;
	/**
	 * 받기 전에 볼트에 이미 있는 같은 내용 파일로 blob을 채운다 — 기존 볼트를 연결할 때 다시 받지 않도록.
	 * 한꺼번에 넘기고(호출자가 묶어서 index를 몇 번만 쓰게), 채운 oid 집합을 돌려받는다.
	 */
	reuse?: (items: { path: string; oid: string }[]) => Promise<Set<string>>;
	/**
	 * isomorphic-git 객체 캐시. 호출자의 작업 하나 동안 공유해야 한다:
	 * 캐시 없이 부르면 호출마다 pack 파일 전체를 다시 읽는다 (obsidian-git이 만든 20MB pack을 70번 → iOS 먹통).
	 */
	cache?: object;
}

/** 이보다 작은 파일은 첫 요청에 한꺼번에 받는다 (노트 대부분) */
const SMALL_BLOB = 64 * 1024;
/** have로 보낼 조상 커밋 수 (브랜치마다) */
const HAVE_DEPTH = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * 원격 브랜치를 받아 objects에 저장하고 refs/remotes/origin/<branch>를 갱신한 뒤 원격 tip oid를 반환한다.
 * 로컬에 커밋이 없으면 depth 1 (shallow clone).
 * 서버가 protocol v2 filter/shallow를 지원하지 않거나 브랜치가 없으면 null (호출자가 기존 방식으로 받는다).
 */
export async function partialFetch(o: PartialFetchOptions): Promise<string | null> {
	if (!(await supportsPartialFetch(o))) return null;
	const refs = await git.listServerRefs({ http: o.http, url: o.url, onAuth: o.onAuth, prefix: `refs/heads/${o.branch}` });
	const tip = refs.find((r) => r.ref === `refs/heads/${o.branch}`)?.oid;
	if (!tip) return null;
	const base = { fs: o.fs as unknown as git.FsClient, dir: o.dir };
	const cache = o.cache ?? {};

	// 1) 커밋 + 트리 + 작은 파일
	if (!(await hasObject(base, tip, cache))) {
		o.onProgress?.("Git: 변경 목록 받는 중…");
		const haves = await localHaves(base, o.branch, cache);
		const shallow = await readShallow(o.fs);
		const args = [`filter blob:limit=${SMALL_BLOB}`, ...shallow.map((s) => `shallow ${s}`), ...(haves.length ? [] : ["deepen 1"])];
		const res = parseFetch(await post(o, fetchRequest([tip], haves, args)));
		await ensureDir(o.fs, ".git/objects/pack");
		await storePack(o, res.pack);
		if (res.shallow.length || res.unshallow.length) {
			const next = new Set([...shallow, ...res.shallow]);
			for (const u of res.unshallow) next.delete(u);
			await o.fs.writeFile(".git/shallow", [...next].join("\n") + "\n");
		}
	}

	// 2) 큰 파일: tip 트리에서 아직 없는 blob만 하나씩
	const blobs = new Map<string, string>();
	await listBlobs(base, (await git.readCommit({ ...base, oid: tip, cache })).commit.tree, cache, blobs, "");
	let missing: { path: string; oid: string }[] = [];
	for (const [oid, path] of blobs) {
		if (await exists(o.fs, `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`)) continue;
		if (await hasObject(base, oid, cache)) continue;
		missing.push({ path, oid });
	}
	if (o.reuse && missing.length) {
		const reused = await o.reuse(missing);
		missing = missing.filter((m) => !reused.has(m.oid));
	}
	let bytes = 0;
	for (let i = 0; i < missing.length; i++) {
		o.onProgress?.(`Git: 큰 파일 받는 중 ${i}/${missing.length}개 (${(bytes / 1048576).toFixed(0)}MB)`);
		const { pack } = parseFetch(await post(o, fetchRequest([missing[i].oid], [], [])));
		bytes += pack.byteLength;
		const packPath = await storePack(o, pack);
		// 큰 파일 pack은 바로 지우므로 공유 캐시에 올리지 않는다 (올리면 받은 파일이 전부 메모리에 남는다)
		const { blob } = await git.readBlob({ ...base, oid: missing[i].oid, cache: {} });
		await git.writeBlob({ ...base, blob });
		await o.fs.unlink(packPath);
		await o.fs.unlink(packPath.replace(/\.pack$/, ".idx"));
	}

	await git.writeRef({ ...base, ref: `refs/remotes/origin/${o.branch}`, value: tip, force: true });
	return tip;
}

/**
 * 커밋 하나의 커밋·트리 객체만 받는다 (파일 내용은 받지 않음). 기존 볼트를 연결할 때 '마지막으로 본 원격 상태'를 알기 위해 쓴다.
 * 서버가 지원하지 않거나 그 커밋이 원격에 없으면(force push 등) false.
 */
export async function fetchTreesOnly(o: PartialFetchOptions, oid: string): Promise<boolean> {
	try {
		if (!(await supportsPartialFetch(o))) return false;
		const base = { fs: o.fs as unknown as git.FsClient, dir: o.dir };
		if (await hasObject(base, oid, o.cache ?? {})) return true;
		const shallow = await readShallow(o.fs);
		const res = parseFetch(await post(o, fetchRequest([oid], [], ["filter blob:none", ...shallow.map((s) => `shallow ${s}`), "deepen 1"])));
		await ensureDir(o.fs, ".git/objects/pack");
		await storePack(o, res.pack);
		if (res.shallow.length) await o.fs.writeFile(".git/shallow", [...new Set([...shallow, ...res.shallow])].join("\n") + "\n");
		return true;
	} catch (e) {
		console.warn("[light-git] 기준 커밋을 받지 못했습니다", oid, e);
		return false;
	}
}

/** 원격도 가진 것으로 보이는 로컬 커밋들: origin/브랜치와 로컬 브랜치의 first-parent 조상 (실제로 있는 것만) */
async function localHaves(base: { fs: git.FsClient; dir: string }, branch: string, cache: object): Promise<string[]> {
	const out = new Set<string>();
	for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
		let oid: string | undefined = await git.resolveRef({ ...base, ref }).catch(() => undefined);
		for (let i = 0; oid && i < HAVE_DEPTH; i++) {
			const c = await git.readCommit({ ...base, oid, cache }).catch(() => null);
			if (!c) break; // shallow 경계 밖: 없는 커밋을 have로 보내면 원격이 필요한 객체를 빼먹는다
			out.add(oid);
			oid = c.commit.parent[0];
		}
	}
	return [...out];
}

async function readShallow(fs: Fs): Promise<string[]> {
	try {
		return String(await fs.readFile(".git/shallow", { encoding: "utf8" }))
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

async function hasObject(base: { fs: git.FsClient; dir: string }, oid: string, cache: object): Promise<boolean> {
	try {
		await git.readObject({ ...base, oid, format: "deflated", cache });
		return true;
	} catch {
		return false;
	}
}

async function supportsPartialFetch(o: PartialFetchOptions): Promise<boolean> {
	const res = await o.http.request({ url: `${o.url}/info/refs?service=git-upload-pack`, method: "GET", headers: headers(o, false) });
	if (res.statusCode !== 200) return false;
	const lines = [...pktLines(await collect(res.body))].filter((p) => p.data).map((p) => dec.decode(p.data!).trim());
	const fetchCap = lines.find((l) => l.startsWith("fetch="));
	return lines.includes("version 2") && !!fetchCap && /\bfilter\b/.test(fetchCap) && /\bshallow\b/.test(fetchCap);
}

function headers(o: PartialFetchOptions, isPost: boolean): Record<string, string> {
	const h: Record<string, string> = { "git-protocol": "version=2" };
	if (isPost) {
		h["content-type"] = "application/x-git-upload-pack-request";
		h["accept"] = "application/x-git-upload-pack-result";
	}
	const auth = o.onAuth();
	if (auth) h["authorization"] = "Basic " + btoa(`${auth.username}:${auth.password}`);
	return h;
}

async function post(o: PartialFetchOptions, body: Uint8Array): Promise<Uint8Array> {
	const res = await o.http.request({
		url: `${o.url}/git-upload-pack`,
		method: "POST",
		headers: headers(o, true),
		body: (async function* () {
			yield body;
		})(),
	});
	const data = await collect(res.body);
	if (res.statusCode !== 200) throw new Error(`git-upload-pack HTTP ${res.statusCode}`);
	return data;
}

function fetchRequest(wants: string[], haves: string[], args: string[]): Uint8Array {
	const lines = ["no-progress", "ofs-delta", ...args, ...wants.map((w) => `want ${w}`), ...haves.map((h) => `have ${h}`), "done"];
	return concat([pkt("command=fetch\n"), enc.encode("0001"), ...lines.map((l) => pkt(l + "\n")), enc.encode("0000")]);
}

/** v2 fetch 응답: shallow-info 섹션과 packfile 섹션(sideband)만 사용 */
function parseFetch(buf: Uint8Array): { shallow: string[]; unshallow: string[]; pack: Uint8Array } {
	const shallow: string[] = [];
	const unshallow: string[] = [];
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
			else if (kind === "unshallow") unshallow.push(oid);
		} else if (section === "packfile") {
			if (data[0] === 1) parts.push(data.subarray(1));
			else if (data[0] === 3) throw new Error(`원격 오류: ${dec.decode(data.subarray(1)).trim()}`);
		}
	}
	if (!parts.length) throw new Error("원격이 packfile을 보내지 않았습니다.");
	return { shallow, unshallow, pack: concat(parts) };
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
async function storePack(o: PartialFetchOptions, pack: Uint8Array): Promise<string> {
	const sha = [...pack.subarray(pack.length - 20)].map((b) => b.toString(16).padStart(2, "0")).join("");
	const path = `.git/objects/pack/pack-${sha}.pack`;
	await o.fs.writeFile(path, pack);
	await git.indexPack({ fs: o.fs as unknown as git.FsClient, dir: o.dir, filepath: path });
	return path;
}

/** tip 트리의 blob oid → 경로 (같은 내용이 여러 곳이면 첫 경로) */
async function listBlobs(base: { fs: git.FsClient; dir: string }, treeOid: string, cache: object, out: Map<string, string>, prefix: string) {
	const { tree } = await git.readTree({ ...base, oid: treeOid, cache });
	for (const e of tree) {
		const path = prefix + e.path;
		if (e.type === "tree") await listBlobs(base, e.oid, cache, out, path + "/");
		else if (e.type === "blob" && !out.has(e.oid)) out.set(e.oid, path);
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
