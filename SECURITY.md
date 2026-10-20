# Security

## 设计上的边界 / Boundaries

- **只代理 loopback**：预览代理只接受 `127.0.0.1`、`localhost`、`[::1]` 作为上游，
  拒绝带用户名密码的 URL，也拒绝 Harness 自身的地址。
- **不联网**：插件本身不发任何外部请求，没有遥测、没有分析、没有更新检查。
- **本地存储**：批注只写浏览器的 `localStorage`（`dsh-lens:v2:*`、`dsh-lens:recent:*`），
  不发往任何服务器。
- **无第三方依赖**：宿主半侧只用 Node 内置模块；客户端半侧依赖 Harness 自带的 React 运行时。
- **不忽略证书错误**：本地 HTTPS 服务按原样转发。

## 需要你注意的 / What you should know

预览是跑在你本机服务「自己的 origin」上的另一个 loopback 端口，注入的浮层只与 Harness 页面
通过带 origin 校验的 `postMessage` 通信。也就是说：**被批注的页面本身仍然在你的浏览器里运行**，
你打开一个页面就等于信任那个页面——这一点和直接用浏览器访问它没有区别。

## 报告问题 / Reporting

请通过 GitHub 的 [private security advisory](https://github.com/xulianglong-akk/dsh-lens/security/advisories/new)
报告，不要在公开 issue 里贴出可利用的细节。
