# AMT Question Bank — Practice Site / AMT 题库练习站

**👉 Start practicing / 开始做题: https://shicheng0810.github.io/question-bank/**

A fast, fully static practice site for Aviation Maintenance Technician (AMT) question banks. Every question is on one page — answer at your own pace. Practice works with **no account at all** (progress is saved in your browser); **sign in with a simple code** only if you want your history and your own banks to follow you across devices.

一个快速、纯静态的航空维修（AMT）题库练习站。所有题目一页平铺，按自己的节奏作答。**完全不登录也能用**（进度存在你自己的浏览器里）；只有当你想让做题历史和自己的题库**跨设备同步**时，才用一个简单的码**登录**。

---

## ✨ Features / 功能

| | English | 中文 |
|---|---|---|
| 📃 | **Flat player** — every question on one page, submit one by one, instant grading | **全平铺做题**：所有题目一页展示，逐题提交即时判分 |
| 🧩 | **Merged practice** — open *All Banks*, tick any combination of banks; duplicates merge automatically | **合并练习**：打开 *All Banks* 勾选任意题库组合，跨库重复题自动去重合并 |
| ❌ | **Wrong-answer review** — missed questions stay in *Wrong Only* until you remove them | **错题重练**：错题保留在 *Wrong Only*，掌握后手动移除 |
| ⭐ | **Stars** — bookmark any question, revisit via *Star Only* | **收藏**：题卡 ☆ 收藏，*Star Only* 随时回看 |
| 🎲 | **Random 150** — exam-sized draw weighted toward least-practiced questions (shown when scope > 150) | **随机抽 150**：按「做得少优先」权重抽题（范围 >150 题时出现） |
| 👤 | **Sign in (optional)** — pick a personal code (phone-friendly, no email/password); your **last 10 rounds** are saved and reloadable on any device | **登录（可选）**：自定义一个码（手机友好、免邮箱/密码），**最近 10 次做题**自动保存、任意设备重新加载 |
| ☁️ | **Private cloud banks** — upload your own bank to your account; only you (with your code) can see or open it, and your progress comes along | **私有云端题库**：把自己的题库传到账号，只有用你的码登录的你能看到/打开，做题进度一并带走 |
| 🔒 | **Protected banks** — AES-GCM-256 encrypted; decrypted only in your browser after entering the password | **密码题库**：AES-GCM-256 加密，输入密码后仅在浏览器内解密 |
| 📥 | **Local import** — practice your own JSON bank on this device (nothing uploaded), or save it to your account | **本地导入**：在本机练习自己的 JSON 题库（不上传），也可一键存到账号 |
| 💬 | **Feedback / report** — flag a wrong answer or typo on any question; it reaches the author in seconds | **反馈/报错**：任意题一键报错别字/错答，几秒直达作者 |
| 🌐 | **3 languages** — English / 中文 / Español UI (questions stay as authored) | **三语界面**：英/中/西（题目内容保持原文） |
| 🎓 | **Built-in tutorial** — auto on first visit; reopen anytime with the **?** button | **新手教程**：首次自动弹出，**?** 按钮随时重看 |
| 🔓 | **No account required** — everything works signed-out; progress is saved in your browser, isolated per bank | **无需账号**：不登录也全部可用，进度按题库存在你的浏览器里 |

## 🚀 How to use / 使用指南

1. Open the **catalog** and pick a bank — or open **All Banks · Merged Practice** and tick the banks you want to combine.
   打开**目录页**选一个题库；或打开 **All Banks · 合并练习**，勾选想一起做的题库组合。
2. Click a choice, then **Submit Answer** (turn on **Auto Submit** to grade on click). Fill-in answers ignore case & spacing (`check list` = `checklist`).
   点选项后按**提交**（开 **Auto Submit** 则点选即判）。填空判分忽略大小写与空格差异。
3. Review with **Wrong Only / Star Only**; use **Random Choose 150** for exam-sized drills.
   用**错题/收藏**视图复习；**随机抽 150** 做考试规模的练习。
4. *(Optional)* Tap **👤 Sign in**, pick a code, and your rounds save automatically — open **history** to reload any of your last 10 on any device.
   *（可选）* 点 **👤 登录** 设一个码，做题自动保存——打开**历史**可在任意设备重新加载最近 10 次中的任意一次。
5. For 🔒 protected banks, enter the password provided by the owner.
   🔒 加密题库需输入持有者提供的密码。

## 👤 Sign in & your data / 登录与你的数据

Signing in is **optional** — practice fully works without it. When you do sign in:

- You pick **any code you like** (4+ characters). The same code = the same account on every device. The code is hashed on the server; the raw code is never stored.
- Your **last 10 practice rounds** are saved, and you can reload any of them (your answers and grading are restored).
- You can keep **private banks** in your account — upload your own JSON, and only you (signed in with your code) can list or open them.
- Everything is stored on a **private serverless backend, keyed by your code's hash**, reachable only with your code — nothing is shared and nobody else can enumerate it.
- Your code is **not a recoverable password**: anyone who knows it can see that history, so don't reuse a real password. Tap **Sign out** to clear it from a shared device.

登录是**可选**的——不登录也完全能练。登录后：

- 你自定义**任意一个码**（4 位以上）。同一个码 = 各设备上同一个账号。码在服务端被哈希，原始码绝不落库。
- **最近 10 次做题**自动保存，可随时重新加载（作答与判分一并还原）。
- 可在账号里放**私有题库**——上传自己的 JSON，只有用你的码登录的你能列出/打开。
- 全部存在**私有服务端、以你的码哈希为键**，只有用你的码才能取——不共享、别人也枚举不到。
- 这个码**不是带找回机制的密码**：知道码的人就能看到那份历史，别用你别处的真实密码。共用电脑上点**退出登录**即清除。

## ✍️ Bring your own bank / 自带题库

Have your own questions? Convert them to the import JSON format (see **[format.html](https://shicheng0810.github.io/question-bank/format.html)**), then either:

- **Import locally** — the catalog's *Import your own bank* keeps it in this browser only; or
- **Save to your account** — tick *Save to my account* on import (or **☁️ Save to account** on an existing local bank) to keep it private in the cloud and open it on any device.

有自己的题目？按导入用 JSON 格式整理（见 **[format.html](https://shicheng0810.github.io/question-bank/format.html)**），然后任选：

- **本地导入**——目录页的「导入自己的题库」只存这个浏览器；或
- **存到账号**——导入时勾选「传到我的账号」（或在已有本地题库上点 **☁️ 存到账号**），私有存云端、任意设备打开。

---

## 📦 About this repo / 关于本仓库

This repository holds **only the static build artifacts** of the site, auto-published on every deploy. The authoring toolchain (Canvas archive extractor, OCR, AI assist, publish pipeline) lives in a private workspace. The optional account features (sign-in, history, private banks, feedback) are served by a private serverless backend — no third-party tracking, no analytics.

本仓库只存放站点的**静态构建产物**，每次部署自动推送更新。制作工具链（Canvas 存档提取器、OCR、AI 辅助、发布管线）在私有工作区，不在此仓库。可选的账号功能（登录、历史、私有题库、反馈）由私有服务端提供，无第三方追踪、无分析统计。

| File / 文件 | Purpose / 用途 |
|---|---|
| `index.html` | Catalog（目录页：题库列表 + 登录 + 本地导入） |
| `player.html` | Universal player（通用播放器，`?bank=<id>` 公开库 / `?mybank=<id>` 私有库） |
| `banks/` | Bank data（题库数据：公开 `.json` / 加密 `.qbpack` / 清单 `index.json`） |
| `local.html` | Player for locally-imported banks（本地导入播放器） |
| `format.html` | JSON format guide（题库格式文档，双语） |

> The previous standalone HTML question banks that used to live in this repo were replaced by this site on 2026-06-12; they remain available in the git history.
> 本仓库原先的旧版独立题库 HTML 已于 2026-06-12 被本站点替代，可在 git 历史中找回。
