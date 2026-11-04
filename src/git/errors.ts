const HANGUL = /[가-힣]/;

/**
 * git·네트워크 오류를 이해할 수 있는 안내로 바꾼다. settings면 설정 화면에서 고칠 수 있는 문제.
 * 한글이 들어 있으면 그대로 둔다: 직접 쓴 안내이거나 파일 이름이 섞인 메시지라 단어로 판단하면 잘못 짚을 수 있다.
 */
export function friendlyError(raw: string): { message: string; settings: boolean } {
	if (!HANGUL.test(raw)) {
		if (/\b40[13]\b|Authentication failed|could not read Username|Invalid username or password|Permission denied|terminal prompts disabled/i.test(raw)) {
			return { message: "인증에 실패했습니다. 설정에서 사용자명과 토큰, 토큰의 저장소 권한을 확인하세요.", settings: true };
		}
		if (/\b404\b|repository .*not found|does not appear to be a git repository/i.test(raw)) {
			return { message: "저장소를 찾을 수 없습니다. 설정에서 저장소 URL을 확인하세요. 비공개 저장소는 토큰도 필요합니다.", settings: true };
		}
		if (/protected branch|GH006/i.test(raw)) {
			return { message: "브랜치 보호 규칙 때문에 push가 거부되었습니다. 저장소의 브랜치 설정을 확인하세요.", settings: false };
		}
		if (/non-fast-forward|fetch first|\[rejected\]/i.test(raw)) {
			return { message: "원격에 새 커밋이 있습니다. 먼저 pull 하세요.", settings: false };
		}
		if (/offline|network|ERR_INTERNET|ERR_NAME|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed out|Could not resolve host|hostname could not be found|Failed to connect|Failed to fetch/i.test(raw)) {
			return { message: "네트워크에 연결할 수 없습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.", settings: false };
		}
	}
	return { message: raw, settings: false };
}

/** 연결 전에 잡을 수 있는 URL 문제. 없으면 null */
export function remoteUrlProblem(url: string, mobile: boolean): string | null {
	if (!url) return "저장소 URL을 입력하세요.";
	if (/^https?:\/\/\S+$/i.test(url)) return null;
	if (mobile) return "모바일에서는 https:// 로 시작하는 저장소 URL만 쓸 수 있습니다.";
	return /^(ssh:\/\/|git@)\S+$/i.test(url) ? null : "저장소 URL 형식을 확인하세요. https:// 또는 SSH 주소를 입력합니다.";
}
