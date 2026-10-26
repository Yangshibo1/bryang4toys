# 慢慢 Momo

一个先在自己的 Mac 上用起来的 AI 日程小宠物。点击桌面上的 GPT 白龙娘，就能记事、查看待办、讨论今天怎么安排；到时间会出现提醒气泡和系统通知。

第一版在本机独立运行，不需要部署后台。数据保存在这台电脑，尚未实现多端同步。

## 在 Mac 上直接使用

在 GitHub 打开本仓库的 **Actions → Build macOS app → 最近一次成功运行 → Artifacts**，下载 `Momo-macOS-arm64.zip`（Apple 芯片）或 `Momo-macOS-x64.zip`（Intel）。下载 Artifacts 需要登录 GitHub。

下载后解压得到 `Momo.app`。安装包通过 GitHub Actions 构建，不在源码文件列表中。每次推送到 `main` 都会重新构建，也可以在 Actions 页面手动运行；安装包保留 30 天。

解压 `release/Momo-macOS-arm64.zip`（Apple 芯片）或 `release/Momo-macOS-x64.zip`（Intel），把 `Momo.app` 拖进“应用程序”并打开。

从 0.1.2 起，个人测试包在 macOS 上完成临时签名，并在打包及解压后执行 `codesign --verify --deep --strict`，随后实际启动解压出的应用验证。0.1.1 的包缺少完整应用签名，已不建议使用，请下载最新成功运行的安装包并替换旧 `Momo.app`，本机任务数据不受替换影响。

临时签名验证应用完整性，不等于 Apple Developer ID 签名和公证。首次打开可能仍需在“系统设置 → 隐私与安全性”中选择“仍要打开”。如新版仍出现“已损坏”，请保留具体错误供排查，不必关闭系统检查。在系统通知设置里允许 Momo 的通知，随后用应用设置中的“测试系统通知”检查是否收到。

- 点击白龙娘打开或收起任务面板；顶部的小拖动条用来移动宠物。
- 关闭面板后，菜单栏中的龙娘图标仍在运行并检查提醒。
- 从菜单栏可以重新打开面板、显示宠物、打开数据文件夹或完全退出。
- **完全退出、Mac 关机或睡眠期间无法准时弹窗。** 下次启动或唤醒时会补查到期任务；已送达的同一次提醒不会反复弹出。

## 先试这几句话

```text
10分钟后提醒我喝水
明天下午三点提醒我开会
周五下午三点提醒我交报告
记一下写报告，预计30分钟，很重要
今天怎么安排
完成 写报告
把开会推迟10分钟
```

未配置 AI 时，以上功能由本地规则完成。没有明确小时的事项先放入待办，不会自动编造提醒时间；可以点击任务标题或铅笔修改时间。不明确的上午或下午、已过去的日期、同时提到多个时间等情况会请你补充。复杂需求可拆开说，或用分号分开完整任务。

“推迟十分钟”统一指从当前时间起十分钟后提醒。任务里的时间是**提醒时刻**；本地模式暂不同时管理“事件时间＋提前提醒”。每天的时间安排是建议，不会擅自改动任务时间。

## 接入 AI

打开右上角设置，填写兼容 OpenAI Chat Completions 的接口：

| 字段 | DeepSeek 示例 | OpenAI 示例 |
| --- | --- | --- |
| API 地址 | `https://api.deepseek.com/v1` | `https://api.openai.com/v1` |
| 模型名称 | `deepseek-chat` | 填写你的账号可用模型 |
| API 密钥 | 在桌面客户端设置中输入自己的 Key | 同左 |

填写后，聊天由所选模型理解，并能新增、完成或调整任务，给出更自然的排程建议。接口报错会显示原因；不会悄悄当作请求已成功。清除密钥即可回到本地模式。聊天模式会把当前任务和最近对话发送给配置的模型接口；Key 和数据保存在本机的应用数据目录，可通过菜单栏打开。

浏览器预览只运行本地记事，不保存或使用 AI Key。网页关闭后也不会继续检查提醒，日常使用请选择桌面客户端。

## 本地开发

使用 Node.js 24（或 >=22.12）。在项目目录运行：

```bash
npm ci
npm run dev
```

`npm run dev` 会构建桌面主进程、启动 Vite，然后打开真实 Electron 面板和桌宠。界面支持热更新；修改主进程后重新启动命令。

其他常用命令：

```bash
npm run dev:web       # 只运行浏览器预览
npm run build         # 类型检查、构建界面与桌面程序
npm test              # 中文时间、排程、持久化、提醒和模型接口测试
npm run test:ui       # 用 Chromium 验证实际网页交互，先 build
npm run test:desktop  # 用真实 Electron 验证 IPC、关闭面板提醒及重启恢复
npm run test:packaged:mac # 在 Mac 上启动解压后的打包应用，先 package:mac
npm run package:mac   # 在 Mac 上生成并验证 Apple Silicon 与 Intel 临时签名包
```

网页测试需要安装 Chromium，可用 `CHROMIUM_PATH` 指定路径。无显示器的 Linux 云环境运行桌面测试需要 Xvfb。macOS 桌面开发和测试直接使用本机图形环境。Mac 安装包只在 macOS 上构建；云环境中使用仓库 Actions 工作流，避免生成未经完整签名的包。仅打包某一种架构时可设置 `MOMO_ARCH=arm64` 或 `MOMO_ARCH=x64`。

Electron 二进制在首次桌面启动或打包时从官方发布下载，并保留校验。使用网络代理的 Node.js 24 环境可设置 `NODE_USE_ENV_PROXY=1 NODE_USE_SYSTEM_CA=1`；打包下载还可设置 `ELECTRON_GET_USE_PROXY=1`。

## 项目结构

```text
src/core       中文时间、记事指令、每日排程和到期判断
src/main       Electron 窗口、菜单栏、持久化、模型请求和提醒循环
src/preload    桌面界面与主进程之间的 API
src/renderer   React 面板、任务编辑、设置和 GPT 白龙娘立绘
src/shared     类型合同和浏览器本地预览适配器
scripts        开发、构建、跨平台打包和功能验证
tests          核心与服务测试
```

## 验证范围

开发环境为 Linux。macOS 通知权限、菜单栏实际外观及安装包首次启动需要在 Mac 上验收。模型接口的请求和任务落盘路径通过本地 HTTP 测试服务验证；未使用真实付费 API Key 测试。

下一步可以在现有本地版本上加入重复日程、日历同步，再根据使用反馈增加跨设备同步。

## 角色素材

GPT 白龙娘采用 [CrossPet](https://github.com/lokicorvus/crosspet) 的原始透明立绘（待机、眨眼、思考、开心、运行），原型「御姐白龙」出自 B 站 **ZipZipPipe**。桌宠、聊天头像、欢迎插画与应用图标使用同一套形象。待机时会轻呼吸与眨眼；AI 请求期间显示思考立绘；到点提醒时切换为运行立绘。

立绘与基于立绘生成的应用图标采用 **CC BY-NC-SA 4.0**；完整来源和声明见 [素材署名](src/renderer/assets/gpt/CREDITS.md) 与 [素材许可](src/renderer/assets/gpt/LICENSE.md)，应用包内也保留了副本。
