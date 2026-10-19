// 计时器行为测试:只从页面外面看(屏幕上的时间 / Focus·Break / 底部提示),时间由 page.clock 模拟
const { test, expect } = require("@playwright/test");
const path = require("path");

// 默认测本地文件;APP_URL=https://random-chime.vercel.app/ npm test 可直接测线上版本
const APP_URL = process.env.APP_URL || "file://" + path.join(__dirname, "..", "index.html");

async function openApp(page){
  await page.clock.install({ time: new Date("2026-10-19T10:00:00") });
  await page.goto(APP_URL);
}

// 系统音频边界的假件:不真正发声,只记下「哪种声音排在音频时钟第几秒」,以及有没有在响之前被取消
async function recordSounds(page){
  await page.addInitScript(() => {
    window.__sounds = [];
    class FakeAudioContext {
      constructor(){ this.state = "suspended"; this.destination = {}; }
      get currentTime(){ return performance.now() / 1000; }            // 各引擎共用一条音频时钟,重建前后的时刻可比
      resume(){ this.state = "running"; return Promise.resolve(); }
      close(){ this.state = "closed"; return Promise.resolve(); }
      createGain(){ return { gain: { value: 1 }, connect(){} }; }
      decodeAudioData(data, ok){
        const buf = { kind: data.byteLength > 25000 ? "bell" : "cash" };   // 内嵌录音:点钞 21.7KB,钟声 32KB
        return Promise.resolve().then(() => { if(ok) ok(buf); return buf; });
      }
      createBufferSource(){
        const ctx = this;
        return { buffer: null, connect(){},
          start(when){ this._rec = { kind: this.buffer.kind, at: when }; window.__sounds.push(this._rec); },
          stop(){ if(this._rec) this._rec.stoppedAt = ctx.currentTime; } };
      }
    }
    window.AudioContext = window.webkitAudioContext = FakeAudioContext;
  });
}

// 到目前为止用户实际听到的声音:时刻已到、且没在响之前被取消;时刻换算成「距点开始那一声几秒」
async function heardSounds(page){
  const { all, now } = await page.evaluate(() => ({ all: window.__sounds, now: performance.now() / 1000 }));
  const t0 = all[0].at;
  return all.filter(s => s.at <= now && (s.stoppedAt === undefined || s.stoppedAt > s.at))
            .map(s => [s.kind, Math.round(s.at - t0)]);
}

// 跟用户一样从设置面板改参数(专注时长调短,让模拟跑得快)
async function configure(page, values){
  await page.click("#gear");
  for(const [id, v] of Object.entries(values)) await page.fill("#" + id, String(v));
  await page.click("#saveSettings");
}

// 后台被 App Nap 拖住:这段时间里页面一次计时都没跑,醒来后只补跑一次
async function stallInBackground(page, duration){ await page.clock.fastForward(duration); }

// Mac 真睡着:墙上时钟(Date)往前跳,performance.now() 不走 —— macOS Safari 的实际表现(WebKit bug 225610)
async function sleepMac(page, ms){
  const now = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(now + ms);
}

test("后台计时被拖住 150 秒,表继续走,Break 按时到来", async ({ page }) => {
  await openApp(page);
  await configure(page, { focusMin: 5 });
  await page.click("#playBtn");
  await page.clock.runFor("01:00");
  await stallInBackground(page, "02:30");
  await page.clock.runFor("01:31");                 // 1:00 + 2:30 + 1:31 = 5:01,专注已结束

  await expect(page.locator("#phase")).toHaveText("Break");
});

test("Mac 合盖睡 30 分钟,醒来后自动暂停,睡的时间不算", async ({ page }) => {
  await openApp(page);
  await configure(page, { focusMin: 5 });
  await page.click("#playBtn");
  await page.clock.runFor("01:00");
  await sleepMac(page, 30 * 60 * 1000);
  await page.clock.runFor("00:01");

  await expect(page.locator("#status")).toHaveText("已自动暂停 · 点按继续");
  await expect(page.locator("#time")).toHaveText("4:00");
});

test("后台被拖住 5 分钟,期间每组提示音仍按原定时刻响,不晚", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 1, maxInterval: 1, focusMin: 30, eyeSec: 7 });
  await page.click("#playBtn");
  await page.clock.runFor("00:01");
  await stallInBackground(page, "05:00");

  const firstFiveMinutes = (await heardSounds(page)).filter(([, t]) => t <= 301);
  expect(firstFiveMinutes).toEqual([
    ["cash", 0],                                      // 点开始
    ["cash", 60], ["cash", 67], ["cash", 127], ["cash", 134],
    ["cash", 194], ["cash", 201], ["cash", 261], ["cash", 268],
  ]);
});

test("暂停后,之前排好的提示音一声都不会再响", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 1, maxInterval: 1, focusMin: 30, eyeSec: 7 });
  await page.click("#playBtn");
  await page.clock.runFor("00:10");
  await page.click("#playBtn");                       // 暂停
  await page.clock.runFor("05:00");

  expect(await heardSounds(page)).toEqual([["cash", 0]]);   // 只有点开始那一声
});

test("后台被拖住时跨过专注结束,钟声仍在专注结束那一刻响", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { focusMin: 5 });
  await page.click("#playBtn");
  await page.clock.runFor("01:00");
  await stallInBackground(page, "05:00");             // 专注在第 5:00 结束,页面到 6:00 才醒

  const bells = (await heardSounds(page)).filter(([kind]) => kind === "bell");
  expect(bells).toEqual([["bell", 300]]);
});

test("后台被拖住时跨过休息结束,下一轮开始的点钞仍准时", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 10, maxInterval: 10, focusMin: 5, bigRestMin: 1 });
  await page.click("#playBtn");
  await page.clock.runFor("04:00");
  await stallInBackground(page, "03:00");             // 专注 5:00 结束、休息 6:00 结束,页面到 7:00 才醒
  await page.clock.runFor("00:01");

  const cash = (await heardSounds(page)).filter(([kind]) => kind === "cash");
  expect(cash).toEqual([["cash", 0], ["cash", 360]]);
});

test("后台被拖住时跨过休息结束,醒来后屏幕倒计时跟原定时间对得上", async ({ page }) => {
  await openApp(page);
  await configure(page, { minInterval: 10, maxInterval: 10, focusMin: 5, bigRestMin: 1 });
  await page.click("#playBtn");
  await page.clock.runFor("04:00");
  await stallInBackground(page, "03:00");             // 第二轮本该 6:00 开始
  await page.clock.runFor("00:01");                   // 现在 7:01 → 第二轮已过 1:01

  await expect(page.locator("#phase")).toHaveText("Focus");
  await expect(page.locator("#time")).toHaveText("3:59");
});

test("被拖住很久、跨过好几轮,醒来时不会一下子补响一串", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 10, maxInterval: 10, focusMin: 5, bigRestMin: 1 });
  await page.click("#playBtn");
  await stallInBackground(page, "20:00");             // 每轮 6 分钟,醒来时已在第 4 轮
  await page.clock.runFor("00:05");

  expect(await heardSounds(page)).toEqual([["cash", 0], ["bell", 300], ["cash", 360]]);
});

test("大休息中暂停再继续,休息结束时仍有点钞", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 10, maxInterval: 10, focusMin: 5, bigRestMin: 1 });
  await page.click("#playBtn");
  await page.clock.runFor("05:30");                   // 进入大休息 30 秒
  await page.click("#playBtn");                       // 暂停
  await page.clock.runFor("01:00");
  await page.click("#playBtn");                       // 继续(响一声点钞),休息还剩 30 秒
  await page.clock.runFor("00:31");

  const cash = (await heardSounds(page)).filter(([kind]) => kind === "cash");
  expect(cash).toEqual([["cash", 0], ["cash", 390], ["cash", 420]]);
});

test("旧版存下的进度还原后,点开始照常出声、表照常走", async ({ page }) => {
  await recordSounds(page);
  await page.addInitScript(() => {                    // 旧版(只有 nextRingAt、没有 rings)存在本机的进度:25:36
    localStorage.setItem("randomChime.session.v1", JSON.stringify({ autoPaused: false, savedAt: Date.now(), st: {
      phase: "focus", running: true, begun: true, totalMs: 2400000, remainingMs: 1536000,
      nextRingAt: 1700000, ringStage: "first", lastTick: 0, _round: 1 } }));
  });
  await openApp(page);
  await expect(page.locator("#time")).toHaveText("25:36");
  await page.click("#playBtn");
  await page.clock.runFor("00:10");

  expect(await heardSounds(page)).toEqual([["cash", 0]]);
  await expect(page.locator("#time")).toHaveText("25:26");
});

test("计时中把大休息改长,休息结束的点钞跟着新时长走", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 10, maxInterval: 10, focusMin: 5, bigRestMin: 1 });
  await page.click("#playBtn");
  await page.clock.runFor("01:00");
  await configure(page, { bigRestMin: 2 });            // 计时中改设置
  await page.clock.runFor("06:05");

  const cash = (await heardSounds(page)).filter(([kind]) => kind === "cash");
  expect(cash).toEqual([["cash", 0], ["cash", 420]]);  // 5:00 专注 + 2:00 休息
});
