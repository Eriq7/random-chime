// 云同步测试:不碰真 Supabase。页面里的 window.randomChimeCloud 换成假云端(数据放 localStorage.__fakeCloud,刷新后还在),
// 只从页面外面看:设置 → 云同步 的文字、学习记录里的格子、假云端里收到了什么
const { test, expect } = require("@playwright/test");
const path = require("path");

const APP_URL = process.env.APP_URL || "file://" + path.join(__dirname, "..", "index.html");
const GOOD_PASSWORD = "good-password";

// signedIn:一打开就已登录(用 email 这个邮箱);cloudSessions:云端原有的记录 { clientId, endedAt(毫秒), minutes }
async function openApp(page, { time = "2026-10-19T10:00:00", signedIn = false, email = "me@example.com", cloudSessions = [] } = {}){
  await page.addInitScript(({ signedIn, email, cloudSessions, GOOD_PASSWORD }) => {
    if(!localStorage.getItem("__fakeCloud"))
      localStorage.setItem("__fakeCloud", JSON.stringify({ user: signedIn ? { id: "u1", email } : null, sessions: cloudSessions, codes: 0 }));
    const read = () => JSON.parse(localStorage.getItem("__fakeCloud")), write = d => localStorage.setItem("__fakeCloud", JSON.stringify(d));
    const net = () => { if(window.__offline) throw Object.assign(new Error("Failed to fetch"), { code: "offline" }); };
    const bad = code => { throw Object.assign(new Error(code), { code }); };
    window.randomChimeCloud = {
      async currentUser(){ net(); return read().user; },
      async signIn(email, password){ net(); if(password !== GOOD_PASSWORD) bad("invalid_credentials"); const d = read(); d.user = { id: "u1", email }; write(d); return d.user; },
      async signUp(email, password){ net(); const d = read(); d.pending = email; write(d); },
      async verifySignupCode(email, code){ net(); if(code !== "123456") bad("otp_expired"); const d = read(); d.user = { id: "u1", email }; write(d); return d.user; },
      async resendSignupCode(){ net(); },
      async sendResetCode(){ net(); },
      async verifyResetCode(email){ net(); return { id: "u1", email }; },
      async setPassword(){ net(); },
      async signOut(){ const d = read(); d.user = null; write(d); },
      async pullSessions(){ net(); return read().sessions; },
      async appendSession(s){ net(); const d = read(); if(!d.sessions.some(r => r.clientId === s.clientId)) d.sessions.push(s); write(d); },
    };
  }, { signedIn, email, cloudSessions, GOOD_PASSWORD });
  await page.clock.install({ time: new Date(time) });
  await page.goto(APP_URL);
}
const cloudRows = page => page.evaluate(() => JSON.parse(localStorage.getItem("__fakeCloud")).sessions);
const elapse = (page, duration) => page.clock.fastForward(duration);
const cell = (page, date) => page.locator(`#heatGrid [data-date="${date}"]`);
async function openStats(page){ await page.click("#gear"); await page.click("#openStats"); }
async function finishOneFocus(page){ await page.click("#playBtn"); await elapse(page, "40:01"); }

test("登录状态下走满一次专注,云端收到 1 条(40 分钟、走完那一刻)", async ({ page }) => {
  await openApp(page, { signedIn: true });
  await finishOneFocus(page);

  const rows = await cloudRows(page);
  expect(rows).toHaveLength(1);
  expect(rows[0].minutes).toBe(40);
  expect(Math.abs(rows[0].endedAt - new Date("2026-10-19T10:40:00").getTime())).toBeLessThan(2000);   // 点开始比整点晚几百毫秒
  expect(rows[0].clientId).toBeTruthy();
});

test("没登录时走满的专注,之后登录就补传到云端", async ({ page }) => {
  await openApp(page);
  await finishOneFocus(page);
  expect(await cloudRows(page)).toHaveLength(0);

  await page.click("#gear");
  await expect(page.locator("#cloudState")).toContainText("未登录");
  await page.click("#openCloud");
  await page.fill("#authEmail", "me@example.com");
  await page.fill("#authPassword", GOOD_PASSWORD);
  await page.click("#authSubmit");

  await expect.poll(() => cloudRows(page).then(r => r.length)).toBe(1);
  await expect(page.locator("#cloudState")).toContainText("me@example.com");
});

test("密码错了:提示出来,没登录", async ({ page }) => {
  await openApp(page);
  await page.click("#gear");
  await page.click("#openCloud");
  await page.fill("#authEmail", "me@example.com");
  await page.fill("#authPassword", "wrong");
  await page.click("#authSubmit");

  await expect(page.locator("#authError")).toContainText("邮箱或密码不对");
  await expect(page.locator("#cloudState")).toContainText("未登录");
});

test("注册:填邮箱密码 → 收验证码 → 填验证码,就登录了", async ({ page }) => {
  await openApp(page);
  await page.click("#gear");
  await page.click("#openCloud");
  await page.click('#authLinks [data-auth-view="signup"]');
  await page.fill("#authEmail", "me@example.com");
  await page.fill("#authPassword", GOOD_PASSWORD);
  await page.click("#authSubmit");
  await expect(page.locator("#authHint")).toContainText("验证码");

  await page.fill("#authCode", "123456");
  await page.click("#authSubmit");
  await expect(page.locator("#cloudState")).toContainText("me@example.com");
});

test("断网时走满的专注先存本地,网络回来后补传,而且只传一次", async ({ page }) => {
  await openApp(page, { signedIn: true });
  await page.evaluate(() => { window.__offline = true; });
  await finishOneFocus(page);
  expect(await cloudRows(page)).toHaveLength(0);
  await page.click("#gear");
  await expect(page.locator("#cloudState")).toContainText("待上传");

  await page.evaluate(() => { window.__offline = false; window.dispatchEvent(new Event("online")); });
  await expect.poll(() => cloudRows(page).then(r => r.length)).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(100);
  expect(await cloudRows(page)).toHaveLength(1);
});

test("换了新设备:云端已有的学习记录,打开就出现在热力图里", async ({ page }) => {
  await openApp(page, { signedIn: true, cloudSessions: [
    { clientId: "a", endedAt: new Date("2026-10-15T09:00:00").getTime(), minutes: 40 },
    { clientId: "b", endedAt: new Date("2026-10-15T11:00:00").getTime(), minutes: 40 } ] });
  await openStats(page);

  await expect(cell(page, "2026-10-15")).toHaveAttribute("data-minutes", "80");
  await expect(cell(page, "2026-10-15")).toHaveAttribute("data-level", "2");
});

test("本地和云端有同一条记录,不会算两次;再同步一次也不会", async ({ page }) => {
  await openApp(page, { signedIn: true });
  await finishOneFocus(page);
  await page.reload();
  await openStats(page);

  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-minutes", "40");
  expect(await cloudRows(page)).toHaveLength(1);
});

test("邮箱很长时,设置里「云同步」那一行不折行,右边「已同步」完整看得见", async ({ page }) => {
  await openApp(page, { signedIn: true, email: "someone.with.a.really.long.name.for.testing@example-university.edu" });
  await page.click("#gear");
  await expect(page.locator("#cloudState")).toContainText("已同步");

  const row = await page.locator("#openCloud").boundingBox(), oneLine = await page.locator("#openStats").boundingBox();
  expect(row.height).toBeLessThanOrEqual(oneLine.height + 1);          // 跟「学习记录」那一行一样高
  const syncShown = await page.evaluate(() => {                          // 「已同步」三个字在按钮里面、没被省略号截掉
    const box = document.querySelector("#cloudState"), btn = document.querySelector("#openCloud").getBoundingClientRect();
    const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    for(let n; (n = walk.nextNode());){
      const i = n.data.indexOf("已同步"); if(i < 0) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 3);
      const rect = r.getBoundingClientRect(), host = n.parentElement;
      return rect.width > 0 && rect.right <= btn.right && host.scrollWidth <= host.clientWidth;
    }
    return false;
  });
  expect(syncShown).toBe(true);
});

test("退出登录后,本机的学习记录还在", async ({ page }) => {
  await openApp(page, { signedIn: true });
  await finishOneFocus(page);
  await page.click("#gear");
  await page.click("#openCloud");
  await page.click("#authSubmit");                    // 已登录时这个按钮是「退出登录」

  await expect(page.locator("#cloudState")).toContainText("未登录");
  await page.click("#openStats");
  await expect(cell(page, "2026-10-19")).toHaveAttribute("data-level", "1");
});
