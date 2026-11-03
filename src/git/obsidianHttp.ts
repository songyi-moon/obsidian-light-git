import { requestUrl } from "obsidian";

type Body = AsyncIterable<Uint8Array> | Iterable<Uint8Array> | undefined;

async function collect(body: Body): Promise<ArrayBuffer | undefined> {
	if (!body) return undefined;
	const parts: Uint8Array[] = [];
	let len = 0;
	for await (const chunk of body as AsyncIterable<Uint8Array>) {
		parts.push(chunk);
		len += chunk.byteLength;
	}
	const out = new Uint8Array(len);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.byteLength;
	}
	return out.buffer;
}

/** isomorphic-git HttpClient. Obsidian requestUrl은 CORS 제한이 없어 모바일에서도 동작한다. */
export const obsidianHttp = {
	async request({ url, method = "GET", headers = {}, body }: { url: string; method?: string; headers?: Record<string, string>; body?: Body }) {
		const res = await requestUrl({ url, method, headers, body: await collect(body), throw: false });
		const resHeaders: Record<string, string> = {};
		for (const [k, v] of Object.entries(res.headers)) resHeaders[k.toLowerCase()] = v;
		const data = new Uint8Array(res.arrayBuffer);
		return {
			url,
			method,
			statusCode: res.status,
			statusMessage: String(res.status),
			headers: resHeaders,
			body: (async function* () {
				yield data;
			})(),
		};
	},
};
