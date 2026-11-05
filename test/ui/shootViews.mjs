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
check("history", info.commits === 5 && info.historyFiles === 2, JSON.stringify([info.commits, info.historyFiles]));
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
check("history marks unpushed commits", JSON.stringify(marks) === "[true,false,false,false,false]", JSON.stringify(marks));

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
// 체크박스 가장자리를 눌러도 체크되고, diff가 열리거나 그룹이 접히지 않는다
await page.evaluate(() => { document.querySelector(".modal-container").style.pointerEvents = "none"; }); // 빈 모달 층이 뷰를 덮고 있어 실제 탭이 닿지 않는다
const tapCorner = async (sel) => {
  const r = await page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; }, sel);
  await page.evaluate(() => { window.__calls.length = 0; });
  await page.mouse.click(r.x + 2, r.y + 2);
  return { size: [r.w, r.h], calls: await page.evaluate(() => JSON.stringify(window.__calls)) };
};
const rowTap = await tapCorner("#staging .light-git-group-body .light-git-file:nth-child(3) .light-git-check-wrap");
check("touch: checkbox hit area fills the row, no diff opens", rowTap.size[0] >= 34 && rowTap.size[1] >= 34 && rowTap.calls === '[["stage",["daily/2026-11-03.md"]]]', JSON.stringify(rowTap));
const headTap = await tapCorner("#staging .light-git-group-head .light-git-check-wrap");
const stillOpen = await page.evaluate(() => getComputedStyle(document.querySelector("#staging .light-git-group-body")).display !== "none");
check("touch: head checkbox doesn't collapse the group", stillOpen && headTap.calls.startsWith('[["stage"'), JSON.stringify(headTap));
const chevronClear = await page.evaluate(() => {
  const head = document.querySelector("#staging .light-git-group-head");
  return head.querySelector(".light-git-chevron").getBoundingClientRect().right <= head.querySelector(".light-git-check-wrap").getBoundingClientRect().left;
});
check("touch: head checkbox leaves the chevron tappable", chevronClear);
const actionSize = await page.evaluate(() => [...document.querySelectorAll("#staging .light-git-file-actions .clickable-icon")].slice(0, 2).map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height, Math.round(r.left)]; }));
check("touch: row buttons are 34px with a gap", actionSize.every(([w, h]) => w >= 34 && h >= 34) && actionSize[1][2] - actionSize[0][2] >= 38, JSON.stringify(actionSize));
await page.screenshot({ path: `${out}/views-mobile-touch.png`, clip: { x: 0, y: 0, width: 640, height: 300 } });
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
// 접힌 구간은 눌러서 그 자리에서 펼친다. 줄 번호가 이어지고, 두 보기 모두 같게 동작
const foldCheck = () => page.evaluate(() => {
  const fold = document.querySelector(".modal .light-git-diff-fold");
  const text = fold?.textContent;
  fold?.click();
  const nums = [...document.querySelectorAll(".modal .light-git-diff .light-git-ln")].map((n) => Number(n.textContent)).filter(Boolean);
  return { text, left: document.querySelectorAll(".modal .light-git-diff-fold").length, codes: [...document.querySelectorAll(".modal .light-git-code")].filter((c) => c.textContent === "줄 15").length, max: Math.max(...nums), ordered: [...document.querySelector(".modal .light-git-diff").textContent].length > 0 };
});
await page.evaluate(() => document.querySelectorAll(".modal-container > .modal").forEach((m) => m.remove()));
await page.evaluate(() => window.openLongDiff());
const foldUnified = await foldCheck();
check("diff fold opens in unified view", foldUnified.text === "··· 22줄 동일 ···" && foldUnified.left === 0 && foldUnified.codes === 1 && foldUnified.max === 30, JSON.stringify(foldUnified));
const order = await page.evaluate(() => [...document.querySelectorAll(".modal .light-git-diff-line")].map((l) => l.querySelector(".light-git-code").textContent).slice(4, 9));
check("diff fold keeps lines in place", JSON.stringify(order) === JSON.stringify(["줄 4", "줄 5", "줄 6", "줄 7", "줄 8"]), JSON.stringify(order));
await page.evaluate(() => [...document.querySelectorAll(".modal .light-git-diff-modes button")][0].click());
const foldSide = await foldCheck();
check("diff fold opens in side view", foldSide.text === "··· 22줄 동일 ···" && foldSide.left === 0 && foldSide.codes === 2 && foldSide.max === 30, JSON.stringify(foldSide));

// 설정: 대소문자가 중요한 칸은 iOS 자동 수정을 끈다
const inputs = await page.evaluate(() => window.__settingInputs().map((i) => [i.type, i.getAttribute("autocapitalize"), i.getAttribute("autocorrect"), i.spellcheck]));
const exact = ["text", "off", "off", false];
check("settings: exact text fields", JSON.stringify(inputs.slice(0, 5)) === JSON.stringify([["url", "off", "off", false], exact, exact, exact, ["password", null, null, inputs[4][3]]]), JSON.stringify(inputs.slice(0, 5)));
check("settings: other fields keep defaults", inputs.slice(5).every((i) => i[1] === null), JSON.stringify(inputs.slice(5)));

// ---------- IntelliJ 흐름 ----------
// Diff: 첫 변경으로 시작, F7 이동, 끝에서 한 번 더 누르면 다음 파일
const press = async (key, mods = []) => {
  for (const m of mods) await page.keyboard.down(m);
  await page.keyboard.press(key);
  for (const m of [...mods].reverse()) await page.keyboard.up(m);
  await new Promise((r) => setTimeout(r, 30));
};
await open("", { width: 1200, height: 700 });
await page.evaluate(() => { window.openNavDiff(); window.__calls.length = 0; });
const navState = () => page.evaluate(() => {
  const body = document.querySelector(".modal .light-git-diff");
  const cur = document.querySelector(".modal .is-current-hunk");
  const b = body.getBoundingClientRect();
  const r = cur?.getBoundingClientRect();
  return {
    title: document.querySelector(".modal .modal-title").textContent,
    counts: [...document.querySelectorAll(".modal .light-git-diff-count")].map((c) => c.textContent),
    edge: document.querySelector(".modal .light-git-diff-edge").textContent,
    current: cur?.textContent ?? "",
    visible: !!r && r.top >= b.top && r.bottom <= b.bottom,
  };
});
let nav = await navState();
check("diff nav: starts on the first change", nav.counts[0] === "1 / 2" && nav.counts[1] === "파일 1 / 3" && nav.current.includes("줄 3 수정") && nav.visible, JSON.stringify(nav));
await page.screenshot({ path: `${out}/diff-nav.png` });
const words = await page.evaluate(() => [...document.querySelectorAll(".modal .is-current-hunk .light-git-word")].map((w) => w.textContent));
check("diff: only the changed word is highlighted", JSON.stringify(words) === JSON.stringify([" 수정"]), JSON.stringify(words));
await press("F7");
nav = await navState();
check("diff nav: F7 goes to the next change and scrolls to it", nav.counts[0] === "2 / 2" && nav.current.includes("줄 31 수정") && nav.visible, JSON.stringify(nav));
await press("F7");
nav = await navState();
check("diff nav: F7 at the end warns first", nav.title === "notes/A.md" && nav.edge.includes("F7") && nav.edge.includes("다음 파일"), JSON.stringify(nav));
await press("F7", ["Shift"]);
nav = await navState();
check("diff nav: moving back clears the warning", nav.counts[0] === "1 / 2" && nav.edge === "", JSON.stringify(nav));
await press("F7");
await press("F7");
await press("F7");
nav = await navState();
check("diff nav: second F7 opens the next file at its first change", nav.title === "notes/B.md" && nav.counts[0] === "1 / 2" && nav.counts[1] === "파일 2 / 3", JSON.stringify(nav));
await press("F7", ["Shift"]);
await press("F7", ["Shift"]);
nav = await navState();
check("diff nav: Shift+F7 twice returns to the previous file's last change", nav.title === "notes/A.md" && nav.counts[0] === "2 / 2", JSON.stringify(nav));
await press("ArrowRight", ["Alt"]);
nav = await navState();
check("diff nav: Alt+Right moves files", nav.title === "notes/B.md", JSON.stringify(nav));
await press("ArrowLeft", ["Alt"]);
await press("ArrowLeft", ["Alt"]);
nav = await navState();
check("diff nav: Alt+Left stops at the first file", nav.title === "notes/A.md", JSON.stringify(nav));

// 블록 되돌리기: 확인 후 그 블록만 바꾸고, 저장에 실패하면 화면을 그대로 둔다
const revertClick = () => page.evaluate(() => document.querySelector(".modal .is-current-hunk .light-git-diff-revert").click());
const confirm = (text) => page.evaluate((t) => [...document.querySelectorAll(".modal button")].find((b) => b.textContent === t).click(), text);
await press("F7", ["Shift"]); // 첫 변경으로
await revertClick();
const askedHunk = await page.evaluate(() => { const s = window.__saved; return { saved: s ?? null, asked: [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "되돌리기") }; });
check("hunk revert: asks first", askedHunk.asked && !askedHunk.saved, JSON.stringify(askedHunk));
await confirm("되돌리기");
await new Promise((r) => setTimeout(r, 30));
const reverted = await page.evaluate(() => {
  const { expected, next } = window.__saved;
  return { keptOther: next.includes("A 줄 31 수정"), restored: next.includes("A 줄 3\n") && !next.includes("A 줄 3 수정"), expectedHas: expected.includes("A 줄 3 수정"), lines: next.split("\n").length, count: document.querySelector(".modal .light-git-diff-count").textContent };
});
check("hunk revert: only that hunk changes", reverted.keptOther && reverted.restored && reverted.expectedHas && reverted.lines === 40 && reverted.count === "1 / 1", JSON.stringify(reverted));
await page.evaluate(() => { window.__saveOk = false; });
await revertClick();
await confirm("되돌리기");
await new Promise((r) => setTimeout(r, 30));
check("hunk revert: failed save keeps the view", (await page.evaluate(() => document.querySelector(".modal .light-git-diff-count").textContent)) === "1 / 1");
await page.evaluate(() => { window.__saveOk = true; });
await page.evaluate(() => [...document.querySelectorAll(".modal .light-git-diff-modes button")][1].click());
check("hunk revert: available in unified view too", await page.evaluate(() => !!document.querySelector(".modal .is-current-hunk .light-git-diff-revert")));
await page.evaluate(() => { window.__calls.length = 0; });
await press("F4");
const f4 = await page.evaluate(() => ({ calls: JSON.stringify(window.__calls), open: !!document.querySelector(".modal .light-git-diff") }));
check("diff: F4 opens the note and closes the diff", f4.calls === '[["openFile",0]]' && !f4.open, JSON.stringify(f4));
await page.evaluate(() => { window.openDiff(); });
check("diff: no revert button without a target", await page.evaluate(() => !document.querySelector(".modal .light-git-diff-revert")));
await page.evaluate(() => document.querySelectorAll(".modal-container > .modal").forEach((m) => m.remove()));

// 변경 목록: 키보드만으로
await open("", { width: 1260, height: 560 });
await page.evaluate(() => { document.querySelector(".modal-container").style.pointerEvents = "none"; window.__calls.length = 0; document.querySelector("#staging .light-git-list").focus(); });
const selectedKey = () => page.evaluate(() => document.querySelector("#staging .is-selected")?.dataset.key ?? null);
await press("ArrowDown");
check("keys: first down selects the group", (await selectedKey()) === "g:changes", String(await selectedKey()));
await press("ArrowDown");
check("keys: next row", (await selectedKey()) === "f:notes/a.md", String(await selectedKey()));
await page.screenshot({ path: `${out}/views-selected.png`, clip: { x: 316, y: 0, width: 300, height: 520 } });
await press("Space");
const spaceCalls = await page.evaluate(() => JSON.stringify(window.__calls));
check("keys: Space toggles the check and keeps the selection", spaceCalls === '[["unstage",["notes/a.md"]]]' && (await selectedKey()) === "f:notes/a.md", spaceCalls);
await page.evaluate(() => { window.__calls.length = 0; });
await press("Enter");
const enterCall = await page.evaluate(() => window.__calls[0]);
check("keys: Enter opens the diff with the whole list", enterCall?.[0] === "openChangeDiff" && enterCall[1] === "notes/a.md" && enterCall[2].length === 4, JSON.stringify(enterCall));
await page.evaluate(() => { window.__calls.length = 0; });
await press("KeyD", ["Control"]);
check("keys: Ctrl+D opens the diff", (await page.evaluate(() => window.__calls[0]?.[0])) === "openChangeDiff");
await page.evaluate(() => { window.__calls.length = 0; });
await press("F4");
check("keys: F4 opens the note", (await page.evaluate(() => JSON.stringify(window.__calls))) === '[["openFile","notes/a.md"]]');
await press("KeyZ", ["Control", "Alt"]);
const askDiscard = await page.evaluate(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "버리기"));
check("keys: Ctrl+Alt+Z asks before discarding", askDiscard);
await page.evaluate(() => document.querySelectorAll(".modal-container > .modal").forEach((m) => m.remove()));
await press("ArrowLeft");
check("keys: left goes up to the group", (await selectedKey()) === "g:changes", String(await selectedKey()));
await press("ArrowLeft");
check("keys: left again collapses", await page.evaluate(() => document.querySelector("#staging .light-git-group").classList.contains("is-collapsed")));
await press("ArrowDown");
check("keys: collapsed rows are skipped", (await selectedKey()) === "g:changes", String(await selectedKey()));
await press("ArrowRight");
check("keys: right expands", await page.evaluate(() => !document.querySelector("#staging .light-git-group").classList.contains("is-collapsed")));
await press("End");
check("keys: End goes to the last row", (await selectedKey()) === "f:old.md", String(await selectedKey()));

// 우클릭 메뉴, 폴더 묶기, 커밋만 하기
const menuItems = await page.evaluate(() => {
  document.querySelector("#staging .light-git-file").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  return window.__menu;
});
check("context menu: same actions as the row", JSON.stringify(menuItems) === JSON.stringify(["차이 보기", "파일 열기", "변경 버리기"]), JSON.stringify(menuItems));
await page.evaluate(() => document.querySelector('#staging [aria-label="폴더별로 묶기"]').click());
check("group toggle: folders on demand", await page.evaluate(() => document.querySelectorAll("#staging .is-folder").length === 3 && document.querySelector('#staging [aria-label="폴더별로 묶기"]').classList.contains("is-active")));
await page.evaluate(() => document.querySelector('#staging [aria-label="폴더별로 묶기"]').click());
check("group toggle: back to flat", await page.evaluate(() => !document.querySelector("#staging .is-folder")));
await page.evaluate(() => { window.__calls.length = 0; document.querySelector("#staging .light-git-message").value = "메시지"; document.querySelector("#staging .light-git-commit-only").click(); });
await new Promise((r) => setTimeout(r, 30));
const onlyCall = await page.evaluate(() => ({ calls: JSON.stringify(window.__calls), msg: document.querySelector("#staging .light-git-message").value }));
check("commit only: no sync, message cleared", onlyCall.calls.startsWith('[["commitOnly","메시지",') && !onlyCall.calls.includes('"sync"') && onlyCall.msg === "", JSON.stringify(onlyCall));
check("commit only: off with no changes", await page.evaluate(() => document.querySelector("#clean .light-git-commit-only").disabled));
check("commit only: off while conflicts remain", await page.evaluate(() => document.querySelector("#merging .light-git-commit-only").disabled));
check("toolbar buttons work from the keyboard", await page.evaluate(() => { const b = document.querySelector('#staging [aria-label="Pull"]'); return b.getAttribute("role") === "button" && b.tabIndex === 0; }));
check("branch shown in the toolbar", (await page.evaluate(() => document.querySelector("#staging .light-git-branch").textContent.trim())) === "main");

// History: 넓으면 목록 | 상세 + 그래프
const wide = () => page.evaluate(() => {
  const root = document.querySelector("#historyWide");
  return {
    isWide: root.querySelector(".light-git-view").classList.contains("is-wide"),
    selected: root.querySelector(".light-git-commit.is-selected .light-git-commit-msg")?.textContent,
    detail: root.querySelector(".light-git-detail-message")?.textContent,
    meta: root.querySelector(".light-git-detail-meta")?.textContent,
    files: root.querySelectorAll(".light-git-commit-detail .light-git-file").length,
    dots: root.querySelectorAll(".light-git-graph circle").length,
    cols: new Set([...root.querySelectorAll(".light-git-graph circle")].map((c) => c.getAttribute("cx"))).size,
    rows: root.querySelectorAll(".light-git-commit").length,
  };
});
await new Promise((r) => setTimeout(r, 60));
const w0 = await wide();
check("history wide: list + detail + graph", w0.isWide && w0.selected.startsWith("vault backup") && w0.files === 2 && w0.dots === 5 && w0.cols === 2, JSON.stringify(w0));
check("history narrow: graph without the detail pane", await page.evaluate(() => document.querySelectorAll("#history .light-git-commit-head .light-git-graph circle").length === 5 && getComputedStyle(document.querySelector("#history .light-git-commit-detail")).display === "none"));
// 좁은 화면: 두 줄 행과 펼친 파일 목록 사이로 선이 끊기지 않아야 한다
const narrowGraph = () => page.evaluate(() => {
  const items = [...document.querySelectorAll("#history .light-git-commit")];
  const xs = (svg, y) => [...svg.querySelectorAll("line")].filter((l) => l.getAttribute("y1") === y).map((l) => l.getAttribute("x1")).sort().join();
  const seams = [];
  items.forEach((item, i) => {
    const next = items[i + 1];
    if (!next) return;
    const body = item.querySelector(".light-git-commit-body");
    const open = getComputedStyle(body).display !== "none";
    const from = open ? body.querySelector(".light-git-graph") : item.querySelector(".light-git-commit-head .light-git-graph");
    const to = next.querySelector(".light-git-commit-head .light-git-graph");
    const ends = [...from.querySelectorAll("line")].filter((l) => l.getAttribute("y2") === "100%").map((l) => l.getAttribute("x2"));
    seams.push({ i, open, gap: Math.round(to.getBoundingClientRect().top - from.getBoundingClientRect().bottom), ends: [...new Set(ends)].sort().join(), next: xs(to, "0") });
  });
  const head = items[0].querySelector(".light-git-commit-head");
  const svg = head.querySelector(".light-git-graph").getBoundingClientRect();
  return {
    seams,
    fits: svg.height === head.getBoundingClientRect().height + 1,
    clear: head.querySelector(".light-git-commit-msg").getBoundingClientRect().left >= svg.right,
    filesClear: [...items[1].querySelectorAll(".light-git-file-name")].every((n) => n.getBoundingClientRect().left >= svg.right),
  };
});
const seamsOk = (g) => g.seams.every((s) => Math.abs(s.gap) <= 1 && s.ends === s.next);
await page.evaluate(() => document.querySelectorAll("#history .light-git-commit-head")[0].click()); // 맨 위 커밋 접기
await new Promise((r) => setTimeout(r, 60));
const g0 = await narrowGraph();
check("history narrow: lines join across rows", g0.seams.length === 4 && g0.seams.every((s) => !s.open) && seamsOk(g0) && g0.fits && g0.clear, JSON.stringify(g0));
await page.evaluate(() => document.querySelectorAll("#history .light-git-commit-head")[1].click()); // 머지 커밋 펼치기: 칸이 2개 지나간다
await new Promise((r) => setTimeout(r, 60));
const g1 = await narrowGraph();
const openSeam = g1.seams.find((s) => s.open);
check("history narrow: lines continue past an opened commit", openSeam?.i === 1 && openSeam.ends.split(",").length === 2 && seamsOk(g1) && g1.filesClear, JSON.stringify(g1));
await page.evaluate(() => document.querySelector("#historyWide .light-git-list").focus());
await press("ArrowDown");
await new Promise((r) => setTimeout(r, 60));
const w1 = await wide();
check("history wide: arrow keys follow in the detail, full message", w1.selected.startsWith("Merge") && w1.detail.includes("본문 줄") && w1.meta.includes("song"), JSON.stringify(w1));
await page.evaluate(() => { window.__calls.length = 0; });
await press("Enter");
const histCall = await page.evaluate(() => window.__calls[0]);
check("history wide: Enter opens the first file's diff with the list", histCall?.[0] === "openCommitDiff" && histCall[2] === "notes/a.md" && histCall[3].length === 2, JSON.stringify(histCall));
await page.setViewport({ width: 3600, height: 560 });
const shootWide = await page.evaluate(() => { window.scrollTo(0, 0); const r = document.querySelector("#historyWide").getBoundingClientRect(); return { x: r.x, y: r.y }; });
await page.screenshot({ path: `${out}/views-history-wide.png`, clip: { x: shootWide.x, y: shootWide.y, width: 900, height: 520 } });
await page.evaluate(() => {
  const i = document.querySelector("#historyWide .light-git-history-filter");
  i.value = "pc에서";
  i.dispatchEvent(new Event("input"));
});
await new Promise((r) => setTimeout(r, 60));
const w2 = await wide();
check("history search: filters by message, hides the graph", w2.rows === 1 && w2.dots === 0 && w2.selected === "PC에서 고친 내용", JSON.stringify(w2));

// 좁은 화면(폰)은 한 줄로 시작 — 고른 방식은 기억되므로 새 페이지에서 확인
await open("", { width: 400, height: 700 });
await page.evaluate(() => window.openDiff());
check("diff: narrow screen starts unified", await page.evaluate(() => document.querySelector(".light-git-diff-modes .is-active").textContent === "한 줄"));

await browser.close();
console.log(failed ? `${failed} FAILED` : "VIEWS PASSED");
process.exit(failed ? 1 : 0);
