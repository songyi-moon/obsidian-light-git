import * as fs from "fs";
import * as path from "path";

/** Obsidian DataAdapter의 필요한 부분만 node fs로 흉내 (테스트용) */
export class MockAdapter {
	constructor(public root: string) {}
	private abs(p: string) {
		return path.join(this.root, p === "/" ? "" : p);
	}
	async stat(p: string) {
		try {
			const s = fs.statSync(this.abs(p));
			return { type: s.isDirectory() ? "folder" : "file", ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
		} catch {
			return null;
		}
	}
	async exists(p: string) {
		return fs.existsSync(this.abs(p));
	}
	async read(p: string) {
		return fs.readFileSync(this.abs(p), "utf8");
	}
	async readBinary(p: string) {
		const b = fs.readFileSync(this.abs(p));
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
	}
	async write(p: string, d: string) {
		fs.writeFileSync(this.abs(p), d);
	}
	async writeBinary(p: string, d: ArrayBuffer) {
		fs.writeFileSync(this.abs(p), Buffer.from(d));
	}
	async mkdir(p: string) {
		fs.mkdirSync(this.abs(p), { recursive: true });
	}
	async rmdir(p: string, recursive: boolean) {
		fs.rmSync(this.abs(p), { recursive });
	}
	async remove(p: string) {
		fs.unlinkSync(this.abs(p));
	}
	async list(p: string) {
		const dir = this.abs(p);
		const prefix = p === "/" ? "" : p + "/";
		const files: string[] = [];
		const folders: string[] = [];
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? folders : files).push(prefix + e.name);
		return { files, folders };
	}
}

/** pack/index 파일 입출력 횟수를 세고, 지정한 경로 쓰기를 한 번 실패시킬 수 있는 어댑터 (iOS 먹통 재현용) */
export class CountingAdapter extends MockAdapter {
	packReads = 0;
	packReadBytes = 0;
	indexWrites = 0;
	/** .git/objects 아래 stat 횟수: 객체를 하나씩 확인한 만큼 늘어난다 */
	objectChecks = 0;
	/** 이 조건에 맞는 경로는 null로 되돌릴 때까지 쓰기 실패 (앱이 도중에 꺼진 상황 흉내. isomorphic-git이 한 번은 재시도한다) */
	failOn: ((p: string) => boolean) | null = null;
	private check(p: string) {
		if (this.failOn?.(p)) throw new Error(`simulated crash while writing ${p}`);
		if (/(^|\/)index$/.test(p)) this.indexWrites++;
	}
	reset() {
		this.packReads = this.packReadBytes = this.indexWrites = this.objectChecks = 0;
	}
	async stat(p: string) {
		if (p.includes(".git/objects/")) this.objectChecks++;
		return super.stat(p);
	}
	async readBinary(p: string) {
		const b = await super.readBinary(p);
		if (p.endsWith(".pack")) {
			this.packReads++;
			this.packReadBytes += b.byteLength;
		}
		return b;
	}
	async write(p: string, d: string) {
		this.check(p);
		return super.write(p, d);
	}
	async writeBinary(p: string, d: ArrayBuffer) {
		this.check(p);
		return super.writeBinary(p, d);
	}
}
