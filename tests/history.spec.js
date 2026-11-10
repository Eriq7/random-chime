// 学习记录(热力图)测试:只从页面外面看(设置 → 学习记录 里每一格的日期 / 色阶 / 分钟数),时间由 page.clock 模拟
const { test, expect } = require("@playwright/test");
const path = require("path");

const APP_URL = process.env.APP_URL || "file://" + path.join(__dirname, "..", "index.html");

async function openApp(page, time = "2026-10-19T10:00:00"){
  await page.clock.install({ time: new Date(time) });
  await page.goto(APP_URL);
}
async function configure(page, values){
  await page.click("#gear");
  for(const [id, v] of Object.entries(values)) await page.fill("#" + id, String(v));
  await page.click("#saveSettings");
}
// 跟用户一样:点齿轮 → 点「学习记录」
async function openStats(page){
  await page.click("#gear");
  await page.click("#openStats");
}
// 快进:页面这段时间一次计时都没跑,醒来补跑一次(跟 timer.spec 的「后台被拖住」一样)。
// 真一格一格走 40 分钟要 9600 次计时、每条测试 45 秒,所以除了第一条,其余都用快进
const elapse = (page, duration) => page.clock.fastForward(duration);
const cell = (page, date) => page.locator(`#heatGrid [data-date="${date}"]`);

test("专注走满 40 分钟,那一天记 40 分钟、色阶 1", async ({ page }) => {
  test.setTimeout(180_000);                           // 真走 9600 次计时:单独跑约 50 秒,全量并行时会更慢,默认 30 秒不够
  await openApp(page);
  await page.click("#playBtn");
  await page.clock.runFor("40:01");
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-level", "1");
  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "40");
  await expect(page.locator("#statsSummary")).toHaveText("过去一年共学习 40 分钟");
});

// 2026-11-10 起按「专注阶段表在走的时间」记,不再只记走满的:中途暂停 / 重置 / 关掉 app,前面学的都算
test("走到 39 分钟暂停,记 39 分钟", async ({ page }) => {
  await openApp(page);
  await page.click("#playBtn");
  await elapse(page, "39:00");
  await page.click("#playBtn");                       // 暂停
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "39");
  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-level", "1");
  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-tip", "今天 · 10月19日 · 学习 39 分钟");
});

test("走到 39:59 点重置,这 39 分 59 秒也记下", async ({ page }) => {
  await openApp(page);
  await page.click("#playBtn");
  await elapse(page, "39:59");
  await page.click("#resetBtn");
  await page.clock.runFor("00:05");
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "40");   // 39.98 分钟,按 0.1 分钟四舍五入
});

test("中途暂停、再继续走完,共记 40 分钟(不多算、不少算)", async ({ page }) => {
  await openApp(page);
  await page.click("#playBtn");
  await elapse(page, "20:00");
  await page.click("#playBtn");                       // 暂停
  await elapse(page, "05:00");
  await page.click("#playBtn");                       // 继续,还剩 20 分钟
  await elapse(page, "20:01");
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "40");
  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-level", "1");
});

test("Eric 的场景:走满 40 → 第二次走 20 暂停 → 关掉 app 重开 → 重置再走满 40,当天 1 小时 40 分钟", async ({ page }) => {
  await openApp(page);
  await page.click("#playBtn");
  await elapse(page, "40:01");                        // 第 1 次走满,进 10 分钟休息
  await elapse(page, "10:00");                        // 休息结束,第 2 次开始
  await elapse(page, "20:00");
  await page.click("#playBtn");                       // 学不动了,暂停
  await page.reload();                                // 关掉 app 再打开(进度还原成暂停)
  await page.click("#resetBtn");
  await page.click("#playBtn");
  await elapse(page, "40:01");                        // 又走满一次
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "100");
  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-level", "2");
  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-tip", "今天 · 10月19日 · 学习 1 小时 40 分钟");
});

test("暂停期间、Break 的时间都不算", async ({ page }) => {
  await openApp(page);
  await page.click("#playBtn");
  await elapse(page, "40:01");                        // 走满 40,进 10 分钟休息
  await elapse(page, "10:00");                        // 休息结束,第 2 次开始
  await elapse(page, "05:00");
  await page.click("#playBtn");                       // 第 2 次走了 5 分钟,暂停
  await elapse(page, "30:00");                        // 暂停 30 分钟
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "45");
});

test("计时中没暂停就关掉 app,再打开时前面走过的时间已经记上", async ({ page }) => {
  await openApp(page);
  await page.click("#playBtn");
  await elapse(page, "20:00");
  await page.reload();                                // 关掉 app 再打开
  await page.reload();                                // 再关一次再打开:不会重复记
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "20");
});

test("计时中页面卡死、连关掉都没来得及存,再打开最多丢最后 1 分钟", async ({ page, context }) => {
  await openApp(page);
  await page.click("#playBtn");
  await elapse(page, "20:00");
  const reopened = await context.newPage();           // 旧页面不走「关掉」那一步(不触发 pagehide),直接另开一个 = 卡死后重开
  await reopened.goto(APP_URL);
  await openStats(reopened);

  const min = Number(await cell(reopened, "2026-10-19").getAttribute("data-minutes"));
  expect(min).toBeGreaterThanOrEqual(19);
  expect(min).toBeLessThanOrEqual(20);
});

test("按设置的专注时长算:设成 25 分钟,走满 25 分钟记 25 分钟", async ({ page }) => {
  await openApp(page);
  await configure(page, { focusMin: 25 });
  await page.click("#playBtn");
  await elapse(page, "25:01");
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "25");
});

test("一天走满 2 次专注(共 80 分钟),色阶升到 2", async ({ page }) => {
  await openApp(page);
  await configure(page, { bigRestMin: 1 });
  await page.click("#playBtn");
  await elapse(page, "40:01");                        // 第 1 次走完,进休息
  await elapse(page, "01:00");                        // 休息 1 分钟结束,第 2 轮开始
  await elapse(page, "40:00");                        // 第 2 次走完
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "80");
  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-level", "2");
});

test("色阶按当天完成的分钟数分:1 次→1、2 次→2、3 次→3、4 次→4", async ({ page }) => {
  await page.addInitScript(() => {                     // 每次走完存成一条 { id, at(走完的时刻), min, up(已传云端) }
    const days = { "2026-10-15": 1, "2026-10-16": 2, "2026-10-17": 3, "2026-10-18": 4, "2026-10-14": 6 };
    const list = [];
    for(const [d, n] of Object.entries(days))
      for(let i = 0; i < n; i++) list.push({ id: d + "-" + i, at: new Date(d + "T1" + i + ":00:00").getTime(), min: 40, up: false });
    localStorage.setItem("randomChime.sessions.v1", JSON.stringify(list));
  });
  await openApp(page);
  await openStats(page);

  for(const [date, level] of [["2026-10-13", "0"], ["2026-10-15", "1"], ["2026-10-16", "2"], ["2026-10-17", "3"], ["2026-10-18", "4"], ["2026-10-14", "4"]])
    await expect(cell(page, date)).toHaveAttribute("data-level", level);
});

test("半夜走完的那次,算走完那一刻的日期", async ({ page }) => {
  await openApp(page, "2026-10-19T23:50:00");
  await page.click("#playBtn");
  await elapse(page, "40:01");                        // 00:30 走完
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-level", "0");
  await expect(cell(page, "2026-10-20")).toHaveAttribute("data-level", "1");
});

test("后台被拖住、过了零点才醒,仍算专注真正走完那一刻的日期", async ({ page }) => {
  await openApp(page, "2026-10-19T23:10:00");
  await page.click("#playBtn");
  await page.clock.runFor("01:00");
  await elapse(page, "01:00:00");                     // 23:50 就该走完,页面 00:11 才醒
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-level", "1");
  await expect(cell(page, "2026-10-20")).toHaveAttribute("data-level", "0");
});

test("刷新页面后,学习记录还在", async ({ page }) => {
  await openApp(page);
  await page.click("#playBtn");
  await elapse(page, "40:01");
  await page.reload();
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-level", "1");
});

test("过去画一整年(53 周、周日起),今天之后画成空的未来格子:不算数、没有悬停提示", async ({ page }) => {
  await openApp(page);                                // 2026-10-19 是周一
  await openStats(page);

  await expect(page.locator("#heatGrid [data-level]")).toHaveCount(366);  // 2025-10-19(周日)… 2026-10-19
  await expect(cell(page, "2025-10-19")).toHaveCount(1);
  await expect(cell(page, "2025-10-18")).toHaveCount(0);
  await expect(cell(page, "2026-10-20")).toHaveAttribute("data-future", "1");
  await expect(cell(page, "2026-10-20")).not.toHaveAttribute("data-tip", /./);
  await expect(cell(page, "2026-10-20")).not.toHaveAttribute("data-level", /./);
});

// 用户一打开就要看到今天:不管窗口多大、横屏竖屏,可见区域左边 4/5 是过去、右边 1/5 是未来,今天卡在分界线上,不用自己左右滑
async function expectTodayAtFourFifths(page){
  const today = cell(page, "2026-10-19");
  await expect(today).toBeInViewport();
  const view = await page.locator("#heatScroll").boundingBox(), box = await today.boundingBox();
  const ratio = (box.x + box.width - view.x) / view.width;              // 今天那一列的右边缘落在可见宽度的哪里
  expect(ratio).toBeGreaterThan(0.72);
  expect(ratio).toBeLessThan(0.88);
}
for(const [w, h, name] of [[1280, 800, "宽窗口"], [700, 900, "窄窗口"], [390, 844, "手机竖屏"], [844, 390, "手机横屏"]]){
  test(`${name}(${w}×${h}):打开学习记录,今天在可见区域约 4/5 处,右边是未来`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await openApp(page);
    await openStats(page);

    await expectTodayAtFourFifths(page);
    await expect(cell(page, "2026-10-20")).toBeInViewport();             // 明天(未来)也看得见
  });
}

test("学习记录开着时改窗口大小,今天仍在约 4/5 处", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  await openStats(page);
  await expectTodayAtFourFifths(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => { try { await expectTodayAtFourFifths(page); return true; } catch { return false; } }).toBe(true);
});

test("今天那一格有「今天」标记,一眼能找到", async ({ page }) => {
  await openApp(page);
  await openStats(page);

  const label = page.locator("#heatToday");
  await expect(label).toHaveText("今天");
  await expect(label).toBeInViewport();
  const l = await label.boundingBox(), c = await cell(page, "2026-10-19").boundingBox();
  expect(Math.abs((l.x + l.width/2) - (c.x + c.width/2))).toBeLessThan(4);   // 标记正对着今天那一列
  await expect(cell(page, "2026-10-19")).toHaveAttribute("aria-current", "date");
});

test("学习记录开着时,按空格不会误触开始计时", async ({ page }) => {
  await openApp(page);
  await openStats(page);
  await page.keyboard.press("Space");

  await expect(page.locator("#phase")).toHaveText("Focus");
  await page.clock.runFor("00:05");
  await expect(page.locator("#time")).toHaveText("40:00");   // 没开始计时
});
