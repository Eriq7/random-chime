// 测试用本机已装的 Chrome(不另下浏览器);时间全部由 page.clock 模拟,40 分钟一秒跑完
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "tests",
  fullyParallel: true,
  use: {
    channel: "chrome",
    headless: true,
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
});
