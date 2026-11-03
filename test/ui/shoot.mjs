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

// 미해결 상태 저장 시도 → 막힘
await page.evaluate(() => { window.__closed = false; window.openMerge(); });
await page.evaluate(() => document.querySelector(".light-git-merge-footer .mod-cta").click());
check("save blocked while unresolved", await page.evaluate(() => window.__closed === false && window.__notices.at(-1).startsWith("아직")));
await page.evaluate(() => document.querySelector(".modal").remove());

// 모바일 (iPhone 폭)
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
await page.goto(url + "?r=" + Math.random() + "#mobile");
const mcols = await page.$eval(".light-git-merge-row:not(.is-stable)", (e) => getComputedStyle(e).gridTemplateColumns.split(" ").length);
check("mobile: stacked 1 column", mcols === 1);
const overflow = await page.evaluate(() => document.querySelector(".modal").scrollWidth > window.innerWidth + 1);
check("mobile: no horizontal overflow", !overflow);
await page.screenshot({ path: `${out}/merge-mobile.png`, fullPage: false });
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
