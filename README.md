# Qplayer

Qplayer 是一个桌面端 Emby 播放器原型：界面使用 Electron，一套 JavaScript 代码运行在 macOS 和 Windows；播放时把 Emby 直链交给 `mpv`，由 `mpv` 调用系统/硬件解码能力。

## 功能

| 能力 | 当前实现 |
| --- | --- |
| 跨平台桌面 | Electron，提供 macOS / Windows 打包脚本 |
| 播放器 | 调用本机 `mpv`，默认参数包含 `--hwdec=auto-safe` |
| Emby | 登录、保存 token、读取媒体库、读取影片/剧集、播放视频流 |
| ExoPlayer | 暂未实现；它更适合 Android 端，Win/mac 版本使用 mpv |

## 开发运行

```bash
npm install
npm start
```

电脑需要先安装 `mpv`，或在登录表单里填写 `mpv` 的完整路径。

## 打包

```bash
npm run dist:mac
npm run dist:win
```

在 macOS 上构建 Windows 安装包通常还需要 Wine；如果本机环境缺失，请在 Windows 或 CI 里执行 `npm run dist:win`。

## 架构

```mermaid
flowchart LR
  UI["Renderer UI"] --> IPC["Electron IPC"]
  IPC --> API["Emby HTTP API"]
  IPC --> Player["mpv process"]
  API --> Library["媒体库 / 媒体项目"]
  Player --> Decode["系统/硬件解码"]
```
