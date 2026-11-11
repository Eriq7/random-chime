// 计时器行为测试:只从页面外面看(屏幕上的时间 / Focus·Break / 底部提示),时间由 page.clock 模拟
const { test, expect } = require("@playwright/test");
const path = require("path");

// 默认测本地文件;APP_URL=https://random-chime.vercel.app/ npm test 可直接测线上版本
const APP_URL = process.env.APP_URL || "file://" + path.join(__dirname, "..", "index.html");

async function openApp(page){
  await page.clock.install({ time: new Date("2026-10-19T10:00:00") });
  await page.goto(APP_URL);
}

// 系统音频边界的假件:不真正发声,只记下「哪种声音排在音频时钟第几秒、排在哪条输出上」、有没有在响之前被取消,
// 每个引擎什么时候开着 / 关着,以及页面什么时候看不见、什么时候一直在往外出声 —— 用来按 Safari 的规矩算页面会不会被冻结、哪条输出被弄坏
async function recordSounds(page){
  await page.addInitScript(() => {
    window.__sounds = []; window.__outputs = []; window.__visibility = []; window.__contexts = [];
    window.__suspendBroken = false;                                   // 测试开关:suspend() 一直不生效(模拟没料到的情况)
    document.addEventListener("visibilitychange", () =>
      window.__visibility.push({ t: performance.now() / 1000, hidden: document.visibilityState === "hidden" }));
    class FakeAudioContext {
      constructor(opts){
        this.sampleRate = (opts && opts.sampleRate) || 48000;           // 采样率不同 = 另一条系统输出(WebKit 按采样率共用输出)
        this.destination = {}; this.bornAt = this.currentTime; this.states = [];
        this._set("suspended"); window.__contexts.push(this);
      }
      _set(state){ this.state = state; this.states.push({ t: this.currentTime, state }); }
      get currentTime(){ return performance.now() / 1000; }            // 各引擎共用一条音频时钟,重建前后的时刻可比
      resume(){ if(this.state !== "closed") this._set("running"); return Promise.resolve(); }
      suspend(){
        if(window.__suspendBroken) return new Promise(() => {});        // 一直不回来,输出一直开着
        if(this.state !== "closed") this._set("suspended"); return Promise.resolve();
      }
      close(){ this._set("closed"); this.closedAt = this.currentTime; return Promise.resolve(); }
      createGain(){ return { gain: { value: 1 }, connect(){} }; }
      decodeAudioData(data, ok){
        const bell = data.byteLength > 25000;                           // 内嵌录音:点钞 21.7KB / 2.2 秒,钟声 32KB / 3.6 秒
        const buf = { kind: bell ? "bell" : "cash", duration: bell ? 3.648 : 2.232 };
        return Promise.resolve().then(() => { if(ok) ok(buf); return buf; });
      }
      createBufferSource(){
        const ctx = this;
        return { buffer: null, connect(){},
          start(when){ this._rec = { kind: this.buffer.kind, at: when, dur: this.buffer.duration, ctx: window.__contexts.indexOf(ctx) }; window.__sounds.push(this._rec); },
          stop(){ if(this._rec) this._rec.stoppedAt = ctx.currentTime; } };
      }
      createConstantSource(){                                           // 一直输出同一个数:不是 0 就算「在出声」
        const ctx = this;
        return { offset: { value: 1 }, connect(){},
          start(){ this._rec = { ctx, node: this, from: ctx.currentTime }; window.__outputs.push(this._rec); },
          stop(){ if(this._rec) this._rec.to = ctx.currentTime; } };
      }
    }
    window.AudioContext = window.webkitAudioContext = FakeAudioContext;
  });
}

// Safari 的规矩(2026-10-28/29、11-10 本机系统日志 + WebKit 源码):窗口连续看不见满 8 分钟(有时只要 10 秒)、页面又已经静了 10 秒,
// 整个网页进程就被冻结。冻结那一刻系统音频输出要是开着(有引擎在 running),那条输出就坏了:之后排到它上面的声音全哑,
// 换新引擎、刷新页面都没用(同一采样率的引擎共用那条输出),只有退出 app 才好;输出关着时被冻结则没事。
// 这里故意用更严的「看不见 + 静了 10 秒就冻」:冻得只会比真机早、比真机多,在这里能响,真机上一定能响
const FREEZE_AFTER_SEC = 10, SOUND_SEC = 2;
function freezeTimes({ sounds, outputs, visibility, now }){
  const hiddenAt = t => visibility.reduce((hidden, v) => v.t <= t ? v.hidden : hidden, false);
  const outputting = t => sounds.some(s => s.at <= t && t < s.at + SOUND_SEC && !(s.stoppedAt <= s.at))
                       || outputs.some(o => o.level !== 0 && o.from <= t && !(o.to <= t));
  const freezes = [];
  for(let t = 0, quiet = 0, frozen = false; t <= now; t++){
    if(!hiddenAt(t)){ quiet = 0; frozen = false; continue; }
    if(frozen) continue;
    quiet = outputting(t) ? 0 : quiet + 1;
    if(quiet >= FREEZE_AFTER_SEC){ freezes.push(t); frozen = true; }
  }
  return freezes;
}
const stateAt = (ctx, t) => ctx.states.reduce((s, x) => x.t <= t ? x.state : s, "suspended");
const runningThrough = (ctx, from, to) => stateAt(ctx, from) === "running" && !ctx.states.some(x => x.t > from && x.t < to && x.state !== "running");

// 到目前为止用户实际听到的声音:时刻已到、没在响之前被取消、从头到尾引擎都开着、那条输出也没被冻结弄坏;时刻换算成「距点开始那一声几秒」
async function heardSounds(page){
  const rec = await page.evaluate(() => ({
    sounds: window.__sounds, visibility: window.__visibility, now: performance.now() / 1000,
    contexts: window.__contexts.map(c => ({ rate: c.sampleRate, states: c.states })),
    outputs: window.__outputs.map(o => ({ from: o.from, to: o.to ?? o.ctx.closedAt, level: o.node.offset.value })) }));
  const broken = [];                                                    // 冻结那一刻开着的输出 {rate, at}:从此坏掉
  freezeTimes(rec).forEach(f => rec.contexts.forEach(c => { if(stateAt(c, f) === "running") broken.push({ rate: c.rate, at: f }); }));
  const t0 = rec.sounds[0].at;
  return rec.sounds.filter(s => {
    const ctx = rec.contexts[s.ctx];
    return s.at <= rec.now && (s.stoppedAt === undefined || s.stoppedAt > s.at)
        && runningThrough(ctx, s.at, Math.min(s.at + s.dur, rec.now))      // 响到一半引擎被关 = 被掐断,不算听到
        && !broken.some(b => b.rate === ctx.rate && b.at <= s.at);
  }).map(s => [s.kind, Math.round(s.at - t0)]);
}

// 此刻有没有引擎开着(开着 = 系统音频输出开着;这时网页被冻结,那条输出就会坏)
async function audioOutputOn(page){
  return page.evaluate(() => window.__contexts.some(c => c.state === "running"));
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

// 页面此刻是不是还在一直往外出声(保活)
async function keepingAudioOn(page){
  return page.evaluate(() => window.__outputs.some(o => o.node.offset.value !== 0 && o.to === undefined && o.ctx.closedAt === undefined));
}

// 窗口被别的窗口盖住 / 切到别的桌面(Safari 把页面标成「看不见」),或者切回来
async function setWindowVisible(page, visible){
  await page.evaluate(visible => {
    Object.defineProperty(document, "visibilityState", { value: visible ? "visible" : "hidden", configurable: true });
    Object.defineProperty(document, "hidden", { value: !visible, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
}
const hideWindow = page => setWindowVisible(page, false);
const showWindow = page => setWindowVisible(page, true);

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

test("窗口一直藏着(Safari 会冻结看不见又不出声的网页),一整轮提示音和结束钟声照样全响", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 3, maxInterval: 3, focusMin: 15, eyeSec: 7 });
  await page.click("#playBtn");
  await hideWindow(page);                             // 切到别的桌面去学习
  await page.clock.runFor("15:01");

  expect(await heardSounds(page)).toEqual([
    ["cash", 0],                                      // 点开始
    ["cash", 180], ["cash", 187], ["cash", 367], ["cash", 374],
    ["cash", 554], ["cash", 561], ["cash", 741], ["cash", 748],
    ["bell", 900],                                    // 专注结束
  ]);
});

test("暂停后、全部轮次结束后,不再一直输出保活信号(不计时就让 Safari 照常冻结页面,不白耗电)", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 10, maxInterval: 10, focusMin: 5, bigRestMin: 1, rounds: 1 });
  await page.click("#playBtn");
  await page.clock.runFor("00:10");
  await page.click("#playBtn");                       // 暂停
  expect(await keepingAudioOn(page)).toBe(false);

  await page.click("#playBtn");                       // 继续,跑完唯一一轮:专注 5 分 + 休息 1 分
  await page.clock.runFor("06:00");
  await expect(page.locator("#phase")).toHaveText("Done");
  expect(await keepingAudioOn(page)).toBe(false);
});

test("暂停后窗口藏过、不到 2 分钟就回来点继续,点钞和之后的提示音照样响", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 1, maxInterval: 1, focusMin: 30, eyeSec: 7 });
  await page.click("#playBtn");
  await page.clock.runFor("00:10");
  await page.click("#playBtn");                       // 暂停
  await hideWindow(page);                             // 切走:不计时、不出声 → Safari 冻结网页
  await page.clock.runFor("00:30");
  await showWindow(page);
  await page.click("#playBtn");                       // 第 40 秒继续,空闲还不到 2 分钟
  await page.clock.runFor("01:00");

  expect(await heardSounds(page)).toEqual([
    ["cash", 0], ["cash", 40],                        // 开始、继续
    ["cash", 90], ["cash", 97],                       // 专注第 1:00 那组(暂停的 30 秒不算)
  ]);
});

test("暂停后窗口藏过,回来在设置里试听点钞,照样能听到", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await page.click("#playBtn");
  await page.clock.runFor("00:10");
  await page.click("#playBtn");                       // 暂停
  await hideWindow(page);
  await page.clock.runFor("00:30");
  await showWindow(page);
  await page.click("#gear");
  await page.click("#testCash");                      // 第 40 秒试听

  expect(await heardSounds(page)).toEqual([["cash", 0], ["cash", 40]]);
});

// 2026-11-10 真机:第 2 轮专注走到 22:35 暂停,切走很久(Mac 还睡了一觉),回来点开始,当场那声点钞就没响
test("专注 20 多分钟暂停、切走很久,回来点开始,当场的点钞和之后的提示音照样响", async ({ page }) => {
  test.setTimeout(180_000);                           // 真走 36 分钟,约 1 分钟
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 5, maxInterval: 5, focusMin: 40, eyeSec: 7 });
  await page.click("#playBtn");
  await page.clock.runFor("22:35");
  await page.click("#playBtn");                       // 暂停(专注第 1355 秒)
  await hideWindow(page);                             // 切走:暂停中藏 10 秒 Safari 就可能冻结网页
  await page.clock.runFor("14:00");
  await showWindow(page);
  await page.click("#playBtn");                       // 墙上第 2195 秒继续
  await page.clock.runFor("06:00");

  expect(await heardSounds(page)).toEqual([
    ["cash", 0],
    ["cash", 300], ["cash", 307], ["cash", 607], ["cash", 614],
    ["cash", 914], ["cash", 921], ["cash", 1221], ["cash", 1228],
    ["cash", 2195],                                   // 继续:当场那声点钞
    ["cash", 2368], ["cash", 2375],                   // 专注第 1528 秒那组
  ]);
});

test("不计时的时候(刚打开、暂停、试听完、全部结束)系统音频输出都关着,Safari 冻结页面也弄不坏它", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await page.clock.runFor("00:01");
  expect(await audioOutputOn(page)).toBe(false);      // 刚打开

  await configure(page, { minInterval: 10, maxInterval: 10, focusMin: 5, bigRestMin: 1, rounds: 1 });
  await page.click("#playBtn");
  expect(await audioOutputOn(page)).toBe(true);       // 计时中开着(保活)
  await page.clock.runFor("00:10");
  await page.click("#playBtn");                       // 暂停
  await page.clock.runFor("00:01");
  expect(await audioOutputOn(page)).toBe(false);

  await page.click("#gear");
  await page.click("#testBell");                      // 试听钟声(3.6 秒)
  await page.clock.runFor("00:02");
  expect(await audioOutputOn(page)).toBe(true);       // 正在响,不掐断
  await page.clock.runFor("00:03");
  expect(await audioOutputOn(page)).toBe(false);      // 响完就关
  await page.click("#saveSettings");

  await page.click("#playBtn");                       // 继续,跑完唯一一轮
  await page.clock.runFor("06:00");
  await expect(page.locator("#phase")).toHaveText("Done");
  await page.clock.runFor("00:01");
  expect(await audioOutputOn(page)).toBe(false);

  const heard = (await heardSounds(page)).map(([kind]) => kind);
  expect(heard.filter(k => k === "bell")).toEqual(["bell", "bell"]);   // 试听那声完整响完 + 专注结束钟声
});

test("万一输出开着时网页被冻过(关输出没生效),回来点开始换一条新输出,照样响;之后也不再用坏掉的那条", async ({ page }) => {
  await recordSounds(page);
  await openApp(page);
  await configure(page, { minInterval: 1, maxInterval: 1, focusMin: 30, eyeSec: 7 });
  await page.evaluate(() => { window.__suspendBroken = true; });
  await page.click("#playBtn");
  await page.clock.runFor("00:10");
  await page.click("#playBtn");                       // 暂停,但关输出没生效
  await hideWindow(page);
  await page.clock.runFor("00:30");                   // 输出开着时被冻结 → 那条输出坏了
  await showWindow(page);
  await page.evaluate(() => { window.__suspendBroken = false; });
  await page.click("#playBtn");                       // 第 40 秒继续
  await page.clock.runFor("00:10");
  await page.click("#playBtn");                       // 第 50 秒暂停
  await hideWindow(page);
  await page.clock.runFor("03:00");                   // 空闲 ≥2 分钟,下次点开始会换新引擎
  await showWindow(page);
  await page.click("#playBtn");                       // 第 230 秒继续
  await page.clock.runFor("00:50");

  expect(await heardSounds(page)).toEqual([
    ["cash", 0], ["cash", 40], ["cash", 230],
    ["cash", 270], ["cash", 277],                     // 专注第 1:00 那组(暂停的不算)
  ]);
});
