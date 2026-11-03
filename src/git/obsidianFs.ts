import type { DataAdapter } from "obsidian";
import { Buffer } from "buffer/";

function fsError(code: string, path: string): Error {
	const e = new Error(`${code}: ${path}`) as Error & { code: string };
	e.code = code;
	return e;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
	// Buffer는 큰 풀(pool)의 일부일 수 있으므로 반드시 offset 기준으로 잘라야 한다.
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

/**
 * Obsidian DataAdapter 위에 isomorphic-git이 요구하는 promise 기반 fs를 구현.
 * stat 값이 매번 같아야 statusMatrix가 파일을 다시 해시하지 않는다(= 속도의 핵심).
 */
export class ObsidianFs {
	/** .git/index stat 캐시: isomorphic-git이 작업 파일 하나마다 index 변경 여부를 stat으로 확인해서, 캐시하면 stat 호출이 절반이 된다 */
	private indexStat: { at: number; st: Awaited<ReturnType<DataAdapter["stat"]>> } | null = null;

	/** root: 저장소로 쓸 vault 하위 폴더 (빈 값 = vault 전체). git 경로는 모두 이 폴더 기준이 된다. */
	constructor(
		private adapter: DataAdapter,
		private root = "",
	) {}

	private norm(path: string): string {
		let p = path.replace(/\\/g, "/").replace(/^\.?\/+/, "").replace(/\/+$/, "");
		if (p === ".") p = "";
		if (this.root) return p === "" ? this.root : `${this.root}/${p}`;
		return p === "" ? "/" : p;
	}

	private isIndex(p: string) {
		return p === (this.root ? `${this.root}/.git/index` : ".git/index");
	}

	private async rawStat(p: string) {
		if (!this.isIndex(p)) return this.adapter.stat(p);
		// index는 이 플러그인만 쓰므로(쓰기 때 무효화) 잠깐 캐시해도 안전. 외부 변경 대비로 1초만.
		if (this.indexStat && Date.now() - this.indexStat.at < 1000) return this.indexStat.st;
		const st = await this.adapter.stat(p);
		this.indexStat = { at: Date.now(), st };
		return st;
	}

	private invalidate(p: string) {
		if (this.isIndex(p)) this.indexStat = null;
	}

	private async statOrThrow(p: string) {
		const st = await this.rawStat(p);
		if (!st) throw fsError("ENOENT", p);
		return st;
	}

	async readFile(path: string, opts?: { encoding?: string } | string) {
		const p = this.norm(path);
		const st = await this.statOrThrow(p);
		if (st.type === "folder") throw fsError("EISDIR", p);
		const encoding = typeof opts === "string" ? opts : opts?.encoding;
		if (encoding === "utf8") return this.adapter.read(p);
		return Buffer.from(await this.adapter.readBinary(p));
	}

	async writeFile(path: string, data: string | Uint8Array, _opts?: unknown) {
		const p = this.norm(path);
		this.invalidate(p);
		if (typeof data === "string") await this.adapter.write(p, data);
		else await this.adapter.writeBinary(p, toArrayBuffer(data));
		this.invalidate(p); // 쓰는 도중 캐시된 옛 stat도 버린다
	}

	async mkdir(path: string) {
		const p = this.norm(path);
		if (await this.adapter.stat(p)) throw fsError("EEXIST", p);
		await this.adapter.mkdir(p);
	}

	async rmdir(path: string) {
		const p = this.norm(path);
		const st = await this.statOrThrow(p);
		if (st.type !== "folder") throw fsError("ENOTDIR", p);
		await this.adapter.rmdir(p, false);
	}

	async unlink(path: string) {
		const p = this.norm(path);
		const st = await this.statOrThrow(p);
		if (st.type === "folder") throw fsError("EISDIR", p);
		this.invalidate(p);
		await this.adapter.remove(p);
	}

	async readdir(path: string): Promise<string[]> {
		const p = this.norm(path);
		const st = await this.statOrThrow(p);
		if (st.type !== "folder") throw fsError("ENOTDIR", p);
		const { files, folders } = await this.adapter.list(p);
		return [...files, ...folders].map((f) => f.slice(f.lastIndexOf("/") + 1));
	}

	async stat(path: string) {
		const p = this.norm(path);
		const st = await this.statOrThrow(p);
		const isDir = st.type === "folder";
		const mtimeMs = Math.floor(st.mtime || 0);
		// iOS에서 ctime이 비어 있으면 NaN 비교로 매번 '변경됨' 판정 → 전체 재해시. mtime으로 대체.
		const ctimeMs = Math.floor(st.ctime || st.mtime || 0);
		return {
			type: isDir ? "dir" : "file",
			mode: isDir ? 0o40000 : 0o100644,
			size: isDir ? 0 : st.size,
			ino: 0,
			dev: 0,
			uid: 0,
			gid: 0,
			mtimeMs,
			ctimeMs,
			isFile: () => !isDir,
			isDirectory: () => isDir,
			isSymbolicLink: () => false,
		};
	}

	lstat(path: string) {
		return this.stat(path);
	}

	async readlink(path: string): Promise<string> {
		throw fsError("ENOENT", path);
	}

	async symlink(_target: string, path: string): Promise<void> {
		throw fsError("ENOTSUP", path);
	}
}
