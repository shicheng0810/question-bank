# AMT Question Bank — Practice Site / AMT 题库练习站

**👉 Start practicing / 开始做题: https://shicheng0810.github.io/question-bank/**

Mirror / 镜像（更新更快）: https://question-bank-78u.pages.dev/

A fully static, no-login practice site for Aviation Maintenance Technician (AMT) question banks. Every question is on one page — answer at your own pace; all progress is saved in your own browser.

纯静态、无需登录的航空维修（AMT）题库练习站。所有题目一页平铺，按自己的节奏作答；全部进度保存在你自己的浏览器里。

---

## ✨ Features / 功能

| | English | 中文 |
|---|---|---|
| 📃 | **Flat player** — every question on one page, submit one by one, instant grading | **全平铺做题**：所有题目一页展示，逐题提交即时判分 |
| 🧩 | **Merged practice** — open *All Banks*, tick any combination of banks; duplicates merge automatically | **合并练习**：打开 *All Banks* 勾选任意题库组合，跨库重复题自动去重合并 |
| ❌ | **Wrong-answer review** — missed questions stay in *Wrong Only* until you remove them | **错题重练**：错题保留在 *Wrong Only*，掌握后手动移除 |
| ⭐ | **Stars** — bookmark any question, revisit via *Star Only* | **收藏**：题卡 ☆ 收藏，*Star Only* 随时回看 |
| 🎲 | **Random 150** — exam-sized draw weighted toward least-practiced questions (shown when scope > 150) | **随机抽 150**：按「做得少优先」权重抽题（范围 >150 题时出现） |
| 🔒 | **Protected banks** — AES-GCM-256 encrypted; decrypted only in your browser after entering the password | **密码题库**：AES-GCM-256 加密，输入密码后仅在浏览器内解密 |
| 📥 | **Local import** — practice your own JSON bank; nothing is uploaded, it stays on your device | **本地导入**：导入自己的 JSON 题库即刻练习，不上传、只存本机 |
| 🌐 | **3 languages** — English / 中文 / Español UI (questions stay as authored) | **三语界面**：英/中/西（题目内容保持原文） |
| 🎓 | **Built-in tutorial** — auto on first visit; reopen anytime with the **?** button | **新手教程**：首次自动弹出，**?** 按钮随时重看 |
| 📵 | **No account, no tracking** — progress lives in `localStorage`, per-bank isolated | **无账号无追踪**：进度存 `localStorage`，按题库隔离 |

## 🚀 How to use / 使用指南

1. Open the **catalog** and pick a bank — or open **All Banks · Merged Practice** and tick the banks you want to combine.
   打开**目录页**选一个题库；或打开 **All Banks · 合并练习**，勾选想一起做的题库组合。
2. Click a choice, then **Submit Answer** (turn on **Auto Submit** to grade on click). Fill-in answers ignore case & spacing (`check list` = `checklist`).
   点选项后按**提交**（开 **Auto Submit** 则点选即判）。填空判分忽略大小写与空格差异。
3. Review with **Wrong Only / Star Only**; use **Random Choose 150** for exam-sized drills.
   用**错题/收藏**视图复习；**随机抽 150** 做考试规模的练习。
4. For 🔒 protected banks, enter the password provided by the owner.
   🔒 加密题库需输入持有者提供的密码。

## ✍️ Bring your own bank / 自带题库

Write questions as a simple JSON array and import them on the catalog page — **format guide with copy-paste examples: [`format.html`](https://shicheng0810.github.io/question-bank/format.html)**.

自己写题库：按 JSON 数组格式编写，目录页「Import your own bank」导入即可练习——**格式说明与可复制示例见 [`format.html`](https://shicheng0810.github.io/question-bank/format.html)**。

```json
[
  { "id": "demo-1", "question": "Which fabric is approved?", "choices": ["Polyester", "Cotton"], "answer": 0 },
  { "id": "demo-2", "question": "Select ALL that apply.", "choices": ["A", "B", "C"], "answers": [0, 2] },
  { "id": "demo-3", "type": "fill", "question": "A hole under ____ inches…", "blanks": [["8", "eight"]] }
]
```

## 📁 What's in this repo / 仓库说明

This repository holds **only the static build artifacts** of the site, auto-published on every deploy. The authoring toolchain (Canvas archive extractor, OCR, AI assist, publish pipeline) lives in a private workspace.

本仓库只存放站点的**静态构建产物**，每次部署自动推送更新。制作工具链（Canvas 存档提取器、OCR、AI 辅助、发布管线）在私有工作区，不在此仓库。

| File / 文件 | Purpose / 用途 |
|---|---|
| `index.html` | Catalog（目录页：题库列表 + 本地导入） |
| `player.html` | Universal player（通用播放器，`?bank=<id>`） |
| `banks/` | Bank data（题库数据：公开 `.json` / 加密 `.qbpack` / 清单 `index.json`） |
| `local.html` | Player for locally-imported banks（本地导入播放器） |
| `format.html` | JSON format guide（题库格式文档，双语） |

> The previous standalone HTML question banks that used to live in this repo were replaced by this site on 2026-06-12; they remain available in the git history.
> 本仓库原先的旧版独立题库 HTML 已于 2026-06-12 被本站点替代，可在 git 历史中找回。
