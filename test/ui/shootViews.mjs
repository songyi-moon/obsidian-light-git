import puppeteer from "puppeteer-core";
import path from "path";
const out = process.argv[2];
const url = "file:///" + path.resolve("test/out/ui/views.html").split(path.sep).join("/");
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage();
let failed = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) failed++; };
page.on("pageerror", (e) => { console.log("PAGE ERROR", e.message); failed++; });

async function open(hash, viewport) {
  await page.setViewport(viewport);
  await page.goto(url + "?r=" + Math.random() + hash);
  await page.evaluate(() => window.__ready);
  await page.evaluate(() => document.querySelector("#history .light-git-commit-head").click()); // 첫 커밋 펼치기
  await new Promise((r) => setTimeout(r, 100));
}

await open("", { width: 1260, height: 560 });
const info = await page.evaluate(() => {
  const groups = (id) => [...document.querySelectorAll(`#${id} .light-git-group`)].map((g) => {
    const head = g.querySelector(".light-git-group-head input");
    return {
      title: g.querySelector(".light-git-group-title").textContent + " " + g.querySelector(".light-git-group-count").textContent,
      files: g.querySelectorAll(".light-git-file").length,
      head: head ? (head.indeterminate ? "some" : head.checked ? "all" : "none") : null,
      rows: [...g.querySelectorAll(".light-git-file input")].map((c) => (c.indeterminate ? "some" : c.checked ? "all" : "none")),
      discard: g.querySelectorAll('[aria-label="변경 버리기"]').length,
    };
  });
  return {
    merging: groups("merging"),
    staging: groups("staging"),
    commits: document.querySelectorAll("#history .light-git-commit").length,
    historyFiles: document.querySelectorAll("#history .light-git-file").length,
    btnMerging: document.querySelector("#merging .light-git-commit-btn").textContent,
    btnStaging: document.querySelector("#staging .light-git-commit-btn").textContent,
    hint: document.querySelector("#staging .light-git-commit-hint").textContent,
    placeholder: document.querySelector("#staging .light-git-message").placeholder,
    commitBoxAtBottom: (() => {
      const pane = document.querySelector("#staging").getBoundingClientRect();
      const box = document.querySelector("#staging .light-git-commit-box").getBoundingClientRect();
      return Math.abs(pane.bottom - box.bottom) < 2;
    })(),
  };
});
console.log(JSON.stringify(info));
check("merging: conflict + changes, no checkboxes/discard", JSON.stringify(info.merging.map((g) => [g.title, g.files, g.head, g.rows.length, g.discard])) === JSON.stringify([["충돌 1", 1, null, 0, 0], ["머지됨 3", 3, null, 0, 0]]));
check("staging: one list with checkboxes (all/some/none)", JSON.stringify(info.staging.map((g) => [g.title, g.files, g.head, g.rows])) === JSON.stringify([["변경 4", 4, "some", ["all", "some", "none", "none"]]]));
check("commit button / hint show selection", info.btnStaging === "2개 커밋 & 동기화" && info.btnMerging === "커밋 & 동기화" && info.hint === "2/4 선택", `${info.btnStaging} | ${info.hint}`);
check("placeholder counts selected files", info.placeholder.includes("(desktop) 2개"), info.placeholder);
check("commit box pinned to bottom", info.commitBoxAtBottom);
check("history", info.commits === 3 && info.historyFiles === 2);
const mergeUi = await page.evaluate(() => {
  const btn = (id) => document.querySelector(`#${id} .light-git-commit-btn`);
  return {
    conflict: [btn("merging").disabled, document.querySelector("#merging .light-git-commit-hint").textContent],
    done: [btn("merged").disabled, btn("merged").textContent, document.querySelector("#merged .light-git-commit-hint").textContent],
  };
});
check("merge: blocked while conflicts remain, then offers to finish", JSON.stringify(mergeUi) === JSON.stringify({ conflict: [true, "충돌 1건 남음"], done: [false, "머지 완료 & 동기화", "머지 커밋"] }), JSON.stringify(mergeUi));
const empty = await page.evaluate(() => {
  const box = document.querySelector("#notConnected .light-git-empty");
  const b = box.querySelector("button");
  const text = b.textContent;
  window.__calls.length = 0;
  b.click();
  const calls = JSON.stringify(window.__calls);
  window.__calls.length = 0;
  return { text, calls };
});
check("not connected without URL: goes to settings", empty.text === "설정 열기" && empty.calls === '[["openSettings"]]', JSON.stringify(empty));
await page.screenshot({ path: `${out}/views.png` });

// 변경이 없으면 커밋 문구를 보여주지 않는다
const clean = await page.evaluate(() => [document.querySelector("#clean .light-git-commit-btn").textContent, document.querySelector("#clean .light-git-message").placeholder]);
check("no changes: button is plain sync", clean[0] === "동기화" && clean[1] === "커밋할 변경 없음", JSON.stringify(clean));

// History: 아직 올리지 않은 커밋만 표시
const marks = await page.evaluate(() => [...document.querySelectorAll("#history .light-git-commit-meta")].map((m) => m.textContent.includes("push 대기")));
check("history marks unpushed commits", JSON.stringify(marks) === "[true,false,false]", JSON.stringify(marks));

// 파일이 많으면 폴더별로 묶고 검색칸을 보여준다
const hiddenFilter = await page.evaluate(() => getComputedStyle(document.querySelector("#staging .light-git-filter")).display === "none");
check("few files: no search box or folders", hiddenFilter && (await page.evaluate(() => !document.querySelector("#staging .is-folder"))));
check("not connected: no search box", await page.evaluate(() => getComputedStyle(document.querySelector("#notConnected .light-git-filter")).display === "none"));
const folders = () => page.evaluate(() => [...document.querySelectorAll("#many .is-folder")].map((g) => {
  const c = g.querySelector(".light-git-group-head input");
  return [g.querySelector(".light-git-group-title").textContent, g.querySelector(".light-git-group-count").textContent, c.indeterminate ? "some" : c.checked ? "all" : "none"];
}));
const f0 = await folders();
check("many files: grouped by folder", JSON.stringify(f0) === JSON.stringify([["(최상위)", "1", "none"], ["daily", "6", "none"], ["notes", "8", "some"]]), JSON.stringify(f0));
await page.screenshot({ path: `${out}/views-many.png`, clip: { x: 2212, y: 0, width: 300, height: 520 } });
await page.evaluate(() => { window.__calls.length = 0; document.querySelectorAll("#many .is-folder .light-git-group-head input")[1].click(); });
const folderCall = await page.evaluate(() => { const c = window.__calls[0]; window.__calls.length = 0; return [c[0], c[1].length]; });
check("folder checkbox selects its files", JSON.stringify(folderCall) === '["stage",6]', JSON.stringify(folderCall));
await page.evaluate(() => { const g = document.querySelectorAll("#many .is-folder")[1]; g.querySelector(".light-git-group-head").click(); });
check("folder collapses", await page.evaluate(() => getComputedStyle(document.querySelectorAll("#many .is-folder")[1].querySelector(".light-git-group-body")).display === "none"));
const search = (q) => page.evaluate((q) => {
  const i = document.querySelector("#many .light-git-filter");
  i.value = q;
  i.dispatchEvent(new Event("input"));
  return {
    files: document.querySelectorAll("#many .light-git-file").length,
    count: document.querySelector("#many .light-git-group-count").textContent,
    empty: document.querySelector("#many .light-git-empty")?.textContent ?? "",
    hint: document.querySelector("#many .light-git-commit-hint").textContent,
    focusKept: document.body.contains(i),
  };
}, q);
const s1f = await search("회의록 3");
check("search narrows the list, commit target unchanged", s1f.files === 1 && s1f.count === "1/15" && s1f.hint.endsWith("/15 선택") && s1f.focusKept, JSON.stringify(s1f));
await page.evaluate(() => { window.__calls.length = 0; document.querySelector("#many .light-git-group-head input").click(); });
const searchCall = await page.evaluate(() => { const c = window.__calls[0]; window.__calls.length = 0; return c; });
check("select-all while searching only touches shown files", JSON.stringify(searchCall) === JSON.stringify(["stage", ["notes/회의록 3.md"]]), JSON.stringify(searchCall));
const s2f = await search("없는파일");
check("search: no results message", s2f.files === 0 && s2f.empty === "검색 결과 없음", JSON.stringify(s2f));
const s3f = await search("");
check("search cleared: all files back", s3f.files === 15 && s3f.count === "15", JSON.stringify(s3f));

// 체크박스/버튼 동작
const instant = await page.evaluate(() => {
  const rows = document.querySelectorAll("#staging .light-git-file input");
  rows[2].click(); // daily: 선택
  // 다시 읽기(상태 확인)를 기다리지 않고 바로 화면에 반영돼야 한다
  const now = { daily: document.querySelectorAll("#staging .light-git-file input")[2].checked, hint: document.querySelector("#staging .light-git-commit-hint")?.textContent };
  rows[0].click(); // a.md: 해제
  return now;
});
check("checkbox updates view instantly", instant.daily === true && instant.hint === "3/4 선택", JSON.stringify(instant));
await page.evaluate(() => {
  document.querySelector("#staging .light-git-group-head input").click(); // 일부 선택 → 전체 선택
  document.querySelector("#staging .light-git-commit-btn").click();
});
const calls = await page.evaluate(() => window.__calls);
check(
  "checkboxes call stage/unstage, commit uses stagedOnly",
  JSON.stringify(calls) === JSON.stringify([["stage", ["daily/2026-11-03.md"]], ["unstage", ["notes/a.md"]], ["stage", ["notes/a.md", "notes/b.md", "daily/2026-11-03.md", "old.md"]], ["sync", null, false, true]]),
  JSON.stringify(calls),
);
// 그룹 접기
await page.evaluate(() => document.querySelector("#staging .light-git-group-head").click());
check("group collapses", await page.evaluate(() => getComputedStyle(document.querySelector("#staging .light-git-group-body")).display === "none"));

// 충돌 사본: 별도 그룹, 체크박스 없음, 커밋 대상 수에서 제외, 비교·삭제
await page.evaluate(() => { window.__calls.length = 0; });
const copies = await page.evaluate(() => {
  const titles = [...document.querySelectorAll("#copies .light-git-group")].map((g) => g.querySelector(".light-git-group-title").textContent + " " + g.querySelector(".light-git-group-count").textContent);
  const group = [...document.querySelectorAll("#copies .light-git-group")][1];
  return {
    titles,
    hint: document.querySelector("#copies .light-git-commit-hint").textContent,
    checks: group.querySelectorAll("input").length,
    undo: group.querySelectorAll('[aria-label="변경 버리기"]').length,
    placeholder: document.querySelector("#copies .light-git-message").placeholder,
  };
});
check("copies: own group, excluded from commit count", JSON.stringify(copies.titles) === JSON.stringify(["변경 1", "충돌 사본 1"]) && copies.hint === "전체 1개" && copies.checks === 0 && copies.undo === 0 && copies.placeholder.includes("(desktop) 1개"), JSON.stringify(copies));
await page.evaluate(() => {
  const row = [...document.querySelectorAll("#copies .light-git-group")][1].querySelector(".light-git-file");
  row.click();
  row.querySelector('[aria-label="사본 삭제"]').click();
});
const confirmBtn = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".modal button")].find((x) => x.textContent === "삭제");
  b?.click();
  return !!b;
});
const copyCalls = await page.evaluate(() => window.__calls);
const copyP = "notes/회의록 (충돌 사본 2026-11-04 1530).md";
check("copies: click compares, delete asks then discards", confirmBtn && JSON.stringify(copyCalls) === JSON.stringify([["openCopyDiff", copyP], ["discard", copyP]]), JSON.stringify(copyCalls));

// 상태 줄: push 대기 / 진행 중 / 마지막 결과
const status = () => page.evaluate(() => {
  const el = document.querySelector("#copies .light-git-status");
  const pull = document.querySelector('#copies [aria-label="Pull"]');
  const hist = document.querySelector('#copies [aria-label="History"]');
  return {
    text: el.textContent,
    spinner: !!el.querySelector(".light-git-spinner"),
    failed: !!el.querySelector(".is-failed"),
    empty: el.classList.contains("is-empty"),
    btnDisabled: document.querySelector("#copies .light-git-commit-btn").disabled,
    pullOff: getComputedStyle(pull).pointerEvents === "none",
    historyOff: getComputedStyle(hist).pointerEvents === "none",
  };
});
const s0 = await status();
check("status: shows unpushed commits", s0.text === "↑ 2개 push 대기" && !s0.spinner && !s0.btnDisabled && !s0.pullOff, JSON.stringify(s0));
check("status: hidden when nothing to say", await page.evaluate(() => getComputedStyle(document.querySelector("#staging .light-git-status")).display === "none"));
await page.evaluate(() => { window.__running = "동기화"; window.__views.copies.renderStatus(); });
const s1 = await status();
check("status: running shows spinner and disables git actions", s1.text === "동기화 중…" && s1.spinner && s1.btnDisabled && s1.pullOff && !s1.historyOff, JSON.stringify(s1));
await page.screenshot({ path: `${out}/views-status-running.png`, clip: { x: 948, y: 0, width: 300, height: 520 } });
await page.evaluate(() => {
  window.__running = null;
  window.__views.copies.plugin.lastRun = { text: "10:12 push 실패", failed: true };
  window.__views.copies.renderStatus();
});
const s2 = await status();
check("status: failure stays visible with unpushed count", s2.text === "↑ 2개 push 대기10:12 push 실패" && s2.failed && !s2.btnDisabled && !s2.pullOff, JSON.stringify(s2));
await page.screenshot({ path: `${out}/views-status-failed.png`, clip: { x: 948, y: 0, width: 300, height: 520 } });

// 다크 테마
await open("#dark", { width: 1000, height: 560 });
await page.screenshot({ path: `${out}/views-dark.png` });
// 터치 기기(폰): 행 버튼이 hover 없이 보여야 함
await open("#mobile", { width: 1000, height: 560, deviceScaleFactor: 2 });
const touchVisible = await page.evaluate(() => getComputedStyle(document.querySelector("#staging .light-git-file-actions")).visibility === "visible");
const rowH = await page.evaluate(() => document.querySelector("#staging .light-git-file").getBoundingClientRect().height);
check("touch: row actions always visible, rows ≥ 34px", touchVisible && rowH >= 34, `h=${rowH}`);
await page.screenshot({ path: `${out}/views-mobile.png`, clip: { x: 0, y: 0, width: 2540, height: 530 } });
// 커밋 입력칸: 평소 1줄, 입력하면 3줄이고 버튼은 제자리
const box = () => page.evaluate(() => {
  const m = document.querySelector("#clean .light-git-message");
  return [m.getBoundingClientRect().height, document.querySelector("#clean .light-git-commit-btn").getBoundingClientRect().top];
});
const idle = await box();
await page.focus("#clean .light-git-message");
const focused = await box();
await page.evaluate(() => document.activeElement.blur());
await page.type("#clean .light-git-message", "메시지");
await page.evaluate(() => document.activeElement.blur());
const typed = await box();
check("touch: message is one line until used", idle[0] < 40 && focused[0] > idle[0] * 1.5 && typed[0] === focused[0] && focused[1] === idle[1], JSON.stringify({ idle, focused, typed }));

// Diff 모달: 넓은 화면은 나란히로 시작, 전환 버튼으로 한 줄
await open("", { width: 1200, height: 700 });
await page.evaluate(() => window.openDiff());
const side = await page.evaluate(() => {
  const rows = [...document.querySelectorAll(".light-git-diff-row")];
  const cells = (r) => [...r.children].map((c) => c.textContent);
  return {
    active: document.querySelector(".light-git-diff-modes .is-active").textContent,
    rows: rows.length,
    changed: rows.filter((r) => r.querySelector(".del,.add,.empty")).map(cells),
    aligned: rows.every((r) => { const [a, , c] = r.children; return Math.abs(a.getBoundingClientRect().top - c.getBoundingClientRect().top) < 1; }),
  };
});
console.log(JSON.stringify(side));
check("diff: wide screen starts side-by-side", side.active === "나란히" && side.rows > 0);
check(
  "diff: changes paired left|right, empty filler",
  JSON.stringify(side.changed) ===
    JSON.stringify([["3", "참석자: 김, 이", "3", "참석자: 김, 이, 박"], ["8", "- 메모 5", "", ""], ["14", "결론: 다음 주", "13", "결론: 이번 주 금요일"], ["", "", "14", "추가 줄"]]),
  JSON.stringify(side.changed),
);
check("diff: left/right rows aligned", side.aligned);
await page.screenshot({ path: `${out}/diff-side.png` });
await page.evaluate(() => [...document.querySelectorAll(".light-git-diff-modes button")][1].click());
const uni = await page.evaluate(() => ({
  active: document.querySelector(".light-git-diff-modes .is-active").textContent,
  side: document.querySelectorAll(".light-git-diff-row").length,
  lines: document.querySelectorAll(".light-git-diff-line.del, .light-git-diff-line.add").length,
}));
check("diff: toggle to unified", uni.active === "한 줄" && uni.side === 0 && uni.lines === 6, JSON.stringify(uni));
await page.screenshot({ path: `${out}/diff-unified.png` });
// 좁은 화면(폰)은 한 줄로 시작 — 고른 방식은 기억되므로 새 페이지에서 확인
await open("", { width: 400, height: 700 });
await page.evaluate(() => window.openDiff());
check("diff: narrow screen starts unified", await page.evaluate(() => document.querySelector(".light-git-diff-modes .is-active").textContent === "한 줄"));

await browser.close();
console.log(failed ? `${failed} FAILED` : "VIEWS PASSED");
process.exit(failed ? 1 : 0);
