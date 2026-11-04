# Light Git (Obsidian 플러그인)

iOS에서도 동작하는 가벼운 Git 동기화 플러그인. obsidian-git의 모바일 불안정(첫 push 시 앱 재시작 등)을 해결하는 것이 목표.

## 기능

- **커밋 & 동기화**: commit → pull(merge) → push. 메시지를 비우면 기본 메시지(템플릿), 입력하면 그 메시지.
- **분할 커밋/분할 push** (모바일 내장 엔진): 큰 변경을 `분할 크기(MB)` 단위 커밋으로 나누고, 같은 브랜치에 fast-forward로 하나씩 push → 한 번에 보내는 pack 크기가 제한됨.
  원격과 갈라져 로컬 머지 커밋이 생긴 경우엔 결과를 원격 tip 위에 분할 커밋으로 다시 쌓아 올린다 (rebase와 같은 효과, 원격 히스토리는 선형).
- **선택 커밋**: 변경 목록의 체크박스로 고른 파일만 커밋 (git staging). 고르지 않으면 전체 커밋. 자동 동기화는 항상 전체.
- **저장소 폴더**: vault의 하위 폴더(예: `notes`)만 git 저장소로 사용 → 기기마다 다른 `.obsidian` 설정이 git에 섞이지 않음. 연결하면 원격을 그 폴더로 clone.
- **pull 보호** (모바일): 커밋 안 한 파일을 원격이 바꿨으면 pull을 멈추고 알려줌 (덮어쓰기 방지).
- **기존 볼트 연결** (모바일): obsidian-git·PC git이 만든 `.git`은 건드리지 않고 `.lightgit`에 따로 저장소를 만든다 (큰 pack을 매번 메모리에 올리지 않도록).
  기존 `.git`이 마지막으로 본 원격 상태를 기준으로 파일마다 판정: 이 기기에서 안 고친 옛 파일은 원격 최신본으로, 이 기기에서만 고친 파일은 '변경'으로 남기고,
  양쪽에서 고친 파일(또는 비교 기준이 없을 때 다른 파일)은 원격 내용을 쓰고 볼트 내용은 `이름 (충돌 사본 날짜 시각).md`로 보관. 플러그인 목록·플러그인 폴더는 항상 기기 것을 유지.
  연결 도중 앱이 꺼지면 다음 연결이 이어서 하며, 그 전까지 pull/커밋은 막힌다.
- **obsidian-git 공존 방지**: 연결할 때 obsidian-git이 켜져 있으면 끄고 진행할지 묻고, 켜져 있는 동안 자동 pull/동기화를 하지 않는다.
- **IntelliJ 스타일 3단 머지 화면**: 내 것 | 결과 | 원격. 영역별 `»`/`«` 적용, `✕` 무시, 결과 직접 편집, "충돌 없는 변경 모두 적용", "모두 내 것/원격". 줄 번호, 변경 종류별 색(수정/추가/삭제/충돌). 폰·태블릿 세로(900px 미만)는 카드형 세로 배치, 태블릿 가로·데스크톱은 3단.
- **Source Control 뷰** (IntelliJ Commit 창 스타일): 충돌/변경 그룹, 체크박스 선택, 파일별 diff, 변경 버리기, 커밋 메시지는 아래 고정. 닫혀 있을 땐 상태 확인을 하지 않음.
- **History 뷰**: 커밋 목록, 커밋별 변경 파일, 파일 diff.
- **엔진**: 데스크톱은 설치된 git, 모바일은 isomorphic-git(Obsidian 파일 API + requestUrl).
- **토큰**은 vault가 아닌 기기별 localStorage에 저장 (git에 올라가지 않음).

## 설치 (수동)

```
npm install
npm run build
```
`main.js`, `manifest.json`, `styles.css`를 vault의 `.obsidian/plugins/light-git/`에 복사.

## 테스트

```
npm test        # 머지 모델 + 로컬 git HTTP 서버 상대 통합 테스트 (iso/native)
npm run test:ui # 머지 화면/뷰를 headless Chrome에서 렌더링·조작 (Chrome 필요)
npm run test:all
```

## 구조

```
src/git/        GitBackend 인터페이스, isoBackend(모바일), nativeBackend(데스크톱), Obsidian fs/http 어댑터
src/merge/      mergeModel(영역 계산·적용 로직, 순수), mergeModal(3단 UI)
src/ui/         Source Control / History 뷰, diff·확인 모달
```

## 미검증 / 알려진 제한

- 실제 iOS 기기 테스트 전. 특히 pull 후 Obsidian 화면 갱신 여부.
- 모바일 엔진에서 원격과 갈라진 뒤 push하면 로컬 머지 커밋 대신 선형 커밋이 올라감 (데스크톱 git은 머지 커밋 그대로).
- 줄 단위(hunk) 스테이징은 없음 — 파일 단위만.
- 기존 obsidian-git이 원격을 받아 놓고(fetch) 머지에 실패한 채 멈춰 있던 볼트라면, 받지 못한 원격 변경이 있는 파일이 '이 기기에서 고친 것'으로 보일 수 있음.
  연결 후 변경 목록을 한 번 확인하고 동기화할 것.
- obsidian-git의 `.git` 폴더는 지우지 않음 (용량을 차지함). 연결이 끝나고 동기화가 잘 되면 PC 등에서 지워도 된다.
