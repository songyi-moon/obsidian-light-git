// isomorphic-git은 전역 Buffer를 기대한다. 모바일(iOS/Android)에는 없으므로 채워 넣는다.
import { Buffer } from "buffer/";
const g = globalThis as unknown as { Buffer?: unknown };
if (!g.Buffer) g.Buffer = Buffer;
