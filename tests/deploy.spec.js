// 部署相关:只对线上版本有意义(APP_URL=https://random-chime.vercel.app/ npm test)
const { test, expect } = require("@playwright/test");

const APP_URL = process.env.APP_URL || "";

// Dock 里的 Web App 一打开就「恢复上次的页面」,走的是历史记录那条路:硬盘缓存里有就直接用、不去线上问新版
// (2026-10-29 系统日志:Cached entry is directly usable)。主页面不让存缓存,重开 app 才一定是最新版
test("线上主页面不让浏览器存缓存,重开 app 一定拿到最新版", async ({ request }) => {
  test.skip(!/^https?:/.test(APP_URL), "只测线上版本");
  const res = await request.get(APP_URL);
  expect(res.headers()["cache-control"]).toContain("no-store");
});
