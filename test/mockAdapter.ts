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
