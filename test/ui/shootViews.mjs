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

await open("", { width: 1000, height: 560 });
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
await page.screenshot({ path: `${out}/views.png` });

// 체크박스/버튼 동작
await page.evaluate(() => {
  const rows = document.querySelectorAll("#staging .light-git-file input");
  rows[2].click(); // daily: 선택
  rows[0].click(); // a.md: 해제
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

// 다크 테마
await open("#dark", { width: 1000, height: 560 });
await page.screenshot({ path: `${out}/views-dark.png` });
// 터치 기기(폰): 행 버튼이 hover 없이 보여야 함
await open("#mobile", { width: 1000, height: 560, deviceScaleFactor: 2 });
const touchVisible = await page.evaluate(() => getComputedStyle(document.querySelector("#staging .light-git-file-actions")).visibility === "visible");
const rowH = await page.evaluate(() => document.querySelector("#staging .light-git-file").getBoundingClientRect().height);
check("touch: row actions always visible, rows ≥ 34px", touchVisible && rowH >= 34, `h=${rowH}`);
await page.screenshot({ path: `${out}/views-mobile.png` });

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
