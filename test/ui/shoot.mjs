// 머지 화면을 실제 Chrome에서 렌더링 → 조작 → 결과 확인 + 스크린샷
import puppeteer from "puppeteer-core";
import path from "path";
const out = process.argv[2];
const url = "file:///" + path.resolve("test/out/ui/index.html").split(path.sep).join("/");
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
let failed = 0;
const check = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); if (!c) failed++; };
const page = await browser.newPage();
page.on("pageerror", (e) => { console.log("PAGE ERROR", e.message); failed++; });

// 데스크톱
await page.setViewport({ width: 1400, height: 900 });
await page.goto(url);
const summary = () => page.$eval(".light-git-merge-summary", (e) => e.textContent);
check("initial summary", (await summary()) === "충돌 2변경 2남음", await summary());
const cols = await page.$eval(".light-git-merge-row:not(.is-stable)", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
check("desktop: 3 columns", cols === 3);
await page.screenshot({ path: `${out}/merge-desktop-initial.png` });

// 툴바 버튼 → 충돌 없는 변경 적용
await page.evaluate(() => [...document.querySelectorAll(".light-git-merge-toolbar button")].find((b) => b.textContent.includes("충돌 없는")).click());
check("apply non-conflicting", (await summary()) === "충돌 2남음", await summary());
// 첫 충돌: 원격 «, 내 것 » 순서로 적용 → 둘 다 들어감
const clickIn = (sel) => page.evaluate((s) => document.querySelector(s).click(), sel);
await clickIn(".kind-conflict.is-pending .col-theirs .light-git-merge-gutter button");
await clickIn(".kind-conflict .col-ours .light-git-merge-gutter button");
// 두 번째 충돌: 결과칸 직접 편집
await page.evaluate(() => {
  const ta = document.querySelector(".kind-conflict.is-pending .light-git-merge-result");
  ta.value = "금요일 확정, 화요일 재확인"; ta.dispatchEvent(new Event("input"));
});
check("all resolved", (await summary()) === "모든 변경을 처리했습니다", await summary());
await page.screenshot({ path: `${out}/merge-desktop-resolved.png` });
await page.evaluate(() => document.querySelector(".light-git-merge-footer .mod-cta").click());
const saved = await page.evaluate(() => window.__saved["notes/회의록.md"]);
check("saved merged content", saved?.includes("참석자: 김, 이, 박") && saved.includes("4. 워크숍") && saved.includes("2. 일정 — 11월 초\n2. 일정 (10월 말로 연기)") && saved.includes("금요일 확정, 화요일 재확인"), JSON.stringify(saved?.slice(0, 120)));
check("modal closed after save", await page.evaluate(() => window.__closed === true));
check("next conflict step runs after the modal closes", await page.evaluate(() => window.__afterResolution === "after close"), await page.evaluate(() => window.__afterResolution));

// 미해결 상태 저장 시도 → 막힘
await page.evaluate(() => { window.__closed = false; window.openMerge(); });
await page.evaluate(() => document.querySelector(".light-git-merge-footer .mod-cta").click());
check("save blocked while unresolved", await page.evaluate(() => window.__closed === false && window.__notices.at(-1).startsWith("아직")));

// 처리한 내용이 있으면 닫기 전에 확인 (Esc·바깥 탭도 close()를 부른다)
const mergeOpen = () => page.evaluate(() => !!document.querySelector(".light-git-merge-modal"));
const clickText = (text) => page.evaluate((t) => [...document.querySelectorAll(".modal button")].find((b) => b.textContent === t)?.click(), text);
await page.evaluate(() => [...document.querySelectorAll(".light-git-merge-toolbar button")].find((b) => b.textContent.includes("충돌 없는")).click());
await page.evaluate(() => document.querySelector(".light-git-merge-footer button").click());
check("close with work: asks first", (await mergeOpen()) && (await page.evaluate(() => !!document.querySelector(".light-git-confirm-text"))));
await page.evaluate(() => document.querySelector(".light-git-confirm-text").parentElement.querySelector("button").click());
check("close with work: cancel keeps the work", (await mergeOpen()) && !(await page.evaluate(() => document.querySelector(".light-git-confirm-text"))) && (await summary()) === "충돌 2남음", await summary());
await page.evaluate(() => document.querySelector(".light-git-merge-footer button").click());
await clickText("버리고 닫기");
check("close with work: confirm closes", !(await mergeOpen()));
await page.evaluate(() => window.openMerge());
await page.evaluate(() => document.querySelector(".light-git-merge-footer button").click());
check("close without work: closes at once", !(await mergeOpen()) && !(await page.evaluate(() => document.querySelector(".light-git-confirm-text"))));

// 미해결 안내는 모바일에 없는 기호(×)를 말하지 않는다
await page.evaluate(() => { window.openMerge(); document.querySelector(".light-git-merge-footer .mod-cta").click(); });
const blockedMsg = await page.evaluate(() => window.__notices.at(-1));
check("unresolved notice names the buttons", blockedMsg.includes("적용하거나 무시") && !blockedMsg.includes("×"), blockedMsg);

// 초기화: 처리한 내용이 있으면 먼저 묻는다
const toolbar = (t) => page.evaluate((t) => [...document.querySelectorAll(".light-git-merge-toolbar button")].find((b) => b.textContent.includes(t)).click(), t);
const confirmBtn = (t) => page.evaluate((t) => [...document.querySelector(".light-git-confirm-text").parentElement.querySelectorAll("button")].find((b) => b.textContent === t).click(), t);
const asking = () => page.evaluate(() => !!document.querySelector(".light-git-confirm-text"));
await toolbar("초기화");
check("reset without work: no question", !(await asking()) && (await summary()) === "충돌 2변경 2남음", await summary());
await toolbar("충돌 없는");
await toolbar("초기화");
check("reset with work: asks first and keeps the work", (await asking()) && (await summary()) === "충돌 2남음", await summary());
await confirmBtn("취소");
check("reset cancelled: work stays", !(await asking()) && (await summary()) === "충돌 2남음", await summary());
await toolbar("초기화");
await confirmBtn("초기화");
check("reset confirmed: back to the start", !(await asking()) && (await summary()) === "충돌 2변경 2남음", await summary());
await page.evaluate(() => document.querySelector(".light-git-merge-footer button").click());

// 파일 단위 선택: 삭제만 먼저 묻고, 내용이 있는 쪽은 바로 저장
const delPath = "notes/지운 파일.md";
const choice = (t) => page.evaluate((t) => [...document.querySelectorAll(".light-git-merge-choice-buttons button")].find((b) => b.textContent.includes(t)).click(), t);
const delSaved = () => page.evaluate((p) => (p in window.__saved ? window.__saved[p] : "unsaved"), delPath);
await page.evaluate(() => window.openMergeDeleted());
await choice("내 것 사용");
check("delete choice: asks first", (await asking()) && (await delSaved()) === "unsaved");
await confirmBtn("취소");
check("delete cancelled: nothing saved", (await delSaved()) === "unsaved" && (await mergeOpen()));
await choice("내 것 사용");
await confirmBtn("삭제");
await new Promise((r) => setTimeout(r, 50));
check("delete confirmed: resolves as deletion", (await delSaved()) === null && !(await mergeOpen()));
await page.evaluate(() => window.openMergeDeleted());
await choice("원격 사용");
await new Promise((r) => setTimeout(r, 50));
check("keeping content: saves at once", (await delSaved()) === "b\n" && !(await asking()) && !(await mergeOpen()));

// 모바일 (iPhone 폭)
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
await page.goto(url + "?r=" + Math.random() + "#mobile");
const mcols = await page.$eval(".light-git-merge-row:not(.is-stable)", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
check("mobile: stacked 1 column", mcols === 1);
const overflow = await page.evaluate(() => document.querySelector(".modal").scrollWidth > window.innerWidth + 1);
check("mobile: no horizontal overflow", !overflow);
const labels = await page.evaluate(() => {
  const b = document.querySelector(".light-git-gutter-btn.is-apply");
  const i = document.querySelector(".light-git-gutter-btn.is-ignore");
  return { apply: b.textContent, ignore: i.textContent, label: getComputedStyle(b.querySelector(".light-git-gutter-label")).display, icon: getComputedStyle(b.querySelector("svg")).display, h: b.getBoundingClientRect().height };
});
check("mobile: gutter buttons use words, not arrows", labels.label !== "none" && labels.icon === "none" && labels.ignore.endsWith("무시") && labels.h >= 28, JSON.stringify(labels));
const nextBtn = () => page.evaluate(() => [...document.querySelectorAll(".light-git-merge-toolbar button")].find((b) => b.textContent.includes("다음 미해결")).click());
const pendingTops = () => page.evaluate(() => {
  const g = document.querySelector(".light-git-merge-grid");
  return { scroll: g.scrollTop, offsets: [...g.querySelectorAll(".is-pending")].map((r) => Math.round(r.getBoundingClientRect().top - g.getBoundingClientRect().top)) };
});
await page.screenshot({ path: `${out}/merge-mobile.png`, fullPage: false });
const n0 = await pendingTops();
await nextBtn();
const n1 = await pendingTops();
check("mobile: next pending scrolls a region to the top", n1.scroll > n0.scroll && n1.offsets.some((o) => Math.abs(o) <= 1), JSON.stringify({ n0, n1 }));
await page.evaluate(() => document.querySelector(".light-git-merge-grid").scrollTop = 0);
// 태블릿: iPad 세로는 카드, 가로는 3단. 둘 다 가로 스크롤 없어야 함
for (const [name, w, h, cols] of [["tablet portrait", 820, 1180, 1], ["tablet landscape", 1180, 820, 3]]) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 2, isMobile: true });
  await page.goto(url + "?r=" + Math.random() + "#mobile");
  const n = await page.$eval(".light-git-merge-row:not(.is-stable)", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
  const over = await page.evaluate(() => document.querySelector(".modal").scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll(".light-git-merge-grid")].some((g) => g.scrollWidth > g.clientWidth + 1));
  check(`${name}: ${cols} column(s), no overflow`, n === cols && !over, `cols=${n} overflow=${over}`);
  await page.screenshot({ path: `${out}/merge-${name.replace(" ", "-")}.png` });
}
// 다크 테마 (데스크톱)
await page.setViewport({ width: 1400, height: 900 });
await page.goto(url + "?r=" + Math.random() + "#dark");
await page.screenshot({ path: `${out}/merge-desktop-dark.png` });
await browser.close();
console.log(failed ? `${failed} FAILED` : "UI ALL PASSED");
process.exit(failed ? 1 : 0);
