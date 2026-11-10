/** 줄바꿈과 BOM만 다른 파일을 찾을 때 한 번에 확인할 최대 수. 넘으면 나머지는 그대로 변경으로 보여 준다 */
export const SAME_TEXT_LIMIT = 300;

const CR = 13;
const LF = 10;

function start(b: Uint8Array) {
	return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
}

/**
 * 줄바꿈(CRLF/LF)과 UTF-8 BOM만 다르면 true. 내용 자체가 같으므로 변경 목록에 보여 주지 않는다.
 * 편집기는 저장할 때 이 둘을 바꾸기도 해서, 글자를 넣었다 지우면 git에는 파일 전체가 바뀐 것처럼 보인다.
 * NUL이 있으면 바이너리로 보고 비교하지 않는다.
 */
export function sameText(a: Uint8Array, b: Uint8Array): boolean {
	let i = start(a);
	let j = start(b);
	while (i < a.length || j < b.length) {
		if (a[i] === CR && a[i + 1] === LF) i++;
		if (b[j] === CR && b[j + 1] === LF) j++;
		if (i >= a.length || j >= b.length) return i >= a.length && j >= b.length;
		if (a[i] !== b[j] || a[i] === 0) return false;
		i++;
		j++;
	}
	return true;
}
