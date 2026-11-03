import * as http from "http";
import { spawn } from "child_process";

/** `git http-backend` CGI를 감싼 로컬 smart HTTP 서버 */
export function startGitServer(projectRoot: string): Promise<{ url: string; close: () => void; requests: { path: string; bytes: number; resBytes: number }[] }> {
	const requests: { path: string; bytes: number; resBytes: number }[] = [];
	const server = http.createServer((req, res) => {
		const u = new URL(req.url!, "http://x");
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const rec = { path: u.pathname, bytes: body.length, resBytes: 0 };
			requests.push(rec);
			const t0 = Date.now();
			if (process.env.GS_DEBUG) console.log("REQ", req.method, u.pathname + u.search, body.length, body.length < 1000 ? JSON.stringify(body.toString()) : "");
			const cgi = spawn("git", ["http-backend"], {
				env: {
					...process.env,
					GIT_PROJECT_ROOT: projectRoot,
					GIT_HTTP_EXPORT_ALL: "1",
					PATH_INFO: u.pathname,
					QUERY_STRING: u.search.slice(1),
					REQUEST_METHOD: req.method,
					CONTENT_TYPE: req.headers["content-type"] || "",
					CONTENT_LENGTH: String(body.length),
					GIT_PROTOCOL: String(req.headers["git-protocol"] || ""),
					REMOTE_USER: "test",
					REMOTE_ADDR: "127.0.0.1",
				},
			});
			// CGI 헤더를 파싱한 뒤 본문은 스트리밍 (큰 pack에서 클라이언트 타임아웃 방지)
			let pending: Buffer | null = Buffer.alloc(0);
			let total = 0;
			cgi.stdout.on("data", (c: Buffer) => {
				total += c.length;
				rec.resBytes = total;
				if (pending === null) return void res.write(c);
				pending = Buffer.concat([pending, c]);
				let sep = pending.indexOf("\r\n\r\n");
				let sepLen = 4;
				if (sep < 0) {
					sep = pending.indexOf("\n\n");
					sepLen = 2;
				}
				if (sep < 0) return;
				let status = 200;
				for (const line of pending.slice(0, sep).toString().split(/\r?\n/)) {
					const i = line.indexOf(":");
					const k = line.slice(0, i).trim();
					const v = line.slice(i + 1).trim();
					if (k.toLowerCase() === "status") status = parseInt(v);
					else res.setHeader(k, v);
				}
				res.statusCode = status;
				const rest = pending.slice(sep + sepLen);
				pending = null;
				res.write(rest);
			});
			cgi.stderr.on("data", (c) => process.stderr.write(c));
			cgi.on("close", (code) => {
				if (process.env.GS_DEBUG) console.log("RES", res.statusCode, total, Date.now() - t0, "ms", "exit", code);
				res.end();
			});
			cgi.stdin.end(body);
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), requests });
		});
	});
}
