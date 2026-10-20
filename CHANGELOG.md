# Changelog

## 0.1.0 — 2026-10-20

首个公开版本。First public release.

- **框选区域 / Region selection** — 按住 Shift 点或拖，框内元素全部收集成一条区域批注，容器标 `[容器]`，叶子元素带文本。
- **样式面板 / Live style panel** — 卡片里的「⚙ 样式」展开后改 font-size、color、padding、margin、line-height、width，页面实时预览；保存时记录 `from → to` 数值，退出圈选时逐条还原。
- **Ctrl+点击立即发送 / Instant send** — Ctrl（macOS 为 Cmd）点元素，写完（或不写）回车，直接把这一条发进当前对话。
- **跨页收集 / Cross-page review** — 会话内所有页面的批注统一收集、按页分组、一次发送（`N 个页面 · M 条`）。
- **只列当前工作区的服务 / Workspace-scoped discovery** — 按进程可执行文件、命令行、声明端口认领服务；其它 loopback 端口不混进来。认不出时手填端口并记住。
- **三个入口 / Three seats** — 右侧栏 tab、`conversation.view` 对话区标签、输入框上方 dock。
- **零残留 / Clean page** — 退出圈选后浮层 DOM、监听、history 补丁、内联样式全部还原。
- **Windows 静态页预览** — 修复 `file:///D:/…` 盘符路径解析，静态页面可以直接批注。
