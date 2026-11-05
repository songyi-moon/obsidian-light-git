export type ChangeType = "added" | "modified" | "deleted";

export interface FileChange {
	path: string;
	type: ChangeType;
}

/** 작업 중인 변경: HEAD→index(staged), index→작업 파일(unstaged). 일부만 스테이징된 파일은 둘 다 true. */
export interface WorkChange extends FileChange {
	staged: boolean;
	unstaged: boolean;
}

/** notes/a (충돌 사본 2026-11-04 1530) 2.md 의 " (충돌 사본 …) 2" 부분 */
const CONFLICT_COPY = / \(충돌 사본 \d{4}-\d{2}-\d{2} \d{4}\)(?: \d+)?(?=\.[^./]*$|$)/;

/**
 * 아직 git에 없는 충돌 사본. 기기에만 두는 보관용이라 커밋하지 않는다.
 * 이미 커밋된 사본은 일반 파일처럼 다룬다 (그래야 삭제·수정을 올릴 수 있다).
 */
export function isNewConflictCopy(c: FileChange): boolean {
	return c.type === "added" && CONFLICT_COPY.test(c.path);
}

/** 충돌 사본 경로 → 원본 경로 */
export function conflictCopyOriginal(path: string): string {
	return path.replace(CONFLICT_COPY, "");
}

/** 커밋 메시지, 또는 커밋할 파일 수를 받아 메시지를 만드는 함수 (상태 확인을 한 번만 하려고) */
export type CommitMessage = string | ((numFiles: number) => string);

export function messageText(m: CommitMessage, numFiles: number): string {
	return typeof m === "string" ? m : m(numFiles);
}

export interface CommitInfo {
	oid: string;
	/** 첫 번째 부모 (최초 커밋/shallow 경계면 없음) */
	parent?: string;
	/** 모든 부모 (머지 커밋은 둘 이상). History 그래프용 */
	parents: string[];
	message: string;
	author: string;
	/** unix seconds */
	timestamp: number;
}

export interface ConflictVersions {
	base: string | null;
	ours: string | null;
	theirs: string | null;
}

export interface GitConfig {
	remoteUrl: string;
	branch: string;
	username: string;
	token: string;
	authorName: string;
	authorEmail: string;
	/** 한 번의 커밋/푸시에 담을 최대 바이트 (모바일 메모리 보호용) */
	chunkBytes: number;
}

/**
 * 데스크톱(네이티브 git)과 모바일(isomorphic-git)이 공통으로 구현하는 인터페이스.
 * Java로 치면 GitBackend 인터페이스 + 구현체 2개 구조.
 */
export interface GitBackend {
	readonly name: string;
	isRepo(): Promise<boolean>;
	/** 저장소가 없으면 init, remote 설정, 원격에 브랜치가 있으면 받아온다. */
	connect(): Promise<string>;
	changes(): Promise<WorkChange[]>;
	/** 파일을 스테이징 (작업 파일이 없으면 삭제를 스테이징) */
	stage(paths: string[]): Promise<void>;
	/** 스테이징 해제 (index를 HEAD 상태로) */
	unstage(paths: string[]): Promise<void>;
	/**
	 * 커밋. stagedOnly면 스테이징된 것만, 아니면 변경 전체.
	 * 머지 중이면 항상 전체를 머지 커밋으로. 만들어진 커밋 수를 반환 (0 = 변경 없음).
	 */
	commit(message: CommitMessage, stagedOnly?: boolean): Promise<number>;
	/** 충돌난 파일 경로 목록을 반환 (빈 배열 = 성공). */
	pull(): Promise<string[]>;
	push(): Promise<void>;
	/** 마지막으로 본 원격 상태 기준, 아직 올리지 않은 커밋 수. 네트워크를 쓰지 않는다. */
	unpushedCount(): Promise<number>;
	/** 위에서 센 커밋들의 oid */
	unpushedCommits(): Promise<string[]>;
	/** 저장소를 건드리지 않고 원격에 접속해 본다. 설정한 브랜치가 원격에 있으면 true, 접속할 수 없으면 예외. */
	checkRemote(): Promise<boolean>;
	/** 머지 진행 중인지 (충돌을 다 해결했어도 머지 커밋 전까지는 true) */
	isMerging(): Promise<boolean>;
	/** 진행 중인 머지에서 아직 해결 안 된 파일 */
	conflicts(): Promise<string[]>;
	/** 충돌 파일의 공통 조상(base) / 내 것(HEAD) / 원격(MERGE_HEAD) 내용. 없는 쪽은 null(삭제). */
	conflictVersions(path: string): Promise<ConflictVersions>;
	/** 머지 화면에서 저장한 파일을 '해결됨'으로 표시 */
	markResolved(path: string): Promise<void>;
	/** rev(HEAD, 커밋 oid 등) 시점의 파일 내용. 없으면 null. */
	readAt(rev: string, path: string): Promise<string | null>;
	/** 작업 중인 변경을 버리고 HEAD 상태로 되돌린다 (새 파일이면 삭제). */
	discard(path: string): Promise<void>;
	log(limit: number): Promise<CommitInfo[]>;
	/** 커밋에서 바뀐 파일 (첫 번째 부모 기준) */
	commitFiles(oid: string): Promise<FileChange[]>;
}
