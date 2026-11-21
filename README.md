# 楼层回溯 · PageIndexExperimentMemory

SillyTavern 的长剧情回溯扩展。它用 PageIndex 导航聊天历史，回读涉及的原楼层，把简短结论和引用注入本轮输入。可手动查楼，也可随正常生成和重新生成自动触发。BM25F 辅助默认关闭。最近 15 楼由当前上下文处理，自动回溯只查更早的历史。

## 从 GitHub 安装

在 SillyTavern 的 **扩展 → 安装扩展** 粘贴以下地址。需要 SillyTavern 1.18 或更新版本和 Git。如果已经装过另一个「楼层回溯」，先在扩展管理器停用旧副本。

```text
https://github.com/NLKASHEI/PageIndexExperimentMemory
```

安装后在右下方点「楼层回溯」展开。拖动标题可移动，点击标题可收起，位置保存在当前浏览器。

默认的浏览器模式沿用酒馆当前的 API 连接，需要一个支持工具调用的 Chat Completion 模型。树形目录、原文读楼和引用核对都在浏览器完成，模型请求走酒馆现有接口。安装者无需安装 Python、启动桥接或申请 PageIndex 云端账号。手机本机运行酒馆或用手机访问远程酒馆，都可用同一链接安装。

浏览器模式移植了 PageIndex 的目录导航和按页回读流程。需要官方 Python SDK，或需要继续使用旧版独立检索 API 方案时，可以在面板中切到「原生 PageIndex · 本机桥接」。浏览器模式的结果缓存和小纪要保存在当前浏览器，每个聊天最多 128 条，全库最多 4096 条。小纪要只在同题时提供原楼号。

## 可选：启动原生 PageIndex 桥接服务

只有切到「原生 PageIndex · 本机桥接」才需要以下步骤。

以下命令从 SillyTavern 根目录运行，假设使用默认用户、默认端口 8000，以及按当前用户安装。若选择了「所有用户」，把扩展路径改为 `public/scripts/extensions/third-party/PageIndexExperimentMemory`。

**Windows PowerShell**

```powershell
$extension = '.\data\default-user\extensions\PageIndexExperimentMemory'
py -3 -m venv .floor-recall-venv
$python = '.\.floor-recall-venv\Scripts\python.exe'
& $python -m pip install -r "$extension\bridge\requirements.txt"
$env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'
$env:OPENAI_AGENTS_DISABLE_TRACING = '1'
& $python -B "$extension\bridge\pageindex_server.py" --tavern-root .
```

**Linux / macOS**

```sh
ext=./data/default-user/extensions/PageIndexExperimentMemory
python3 -m venv .floor-recall-venv
.floor-recall-venv/bin/python -m pip install -r "$ext/bridge/requirements.txt"
LITELLM_LOCAL_MODEL_COST_MAP=True OPENAI_AGENTS_DISABLE_TRACING=1 \
  .floor-recall-venv/bin/python -B "$ext/bridge/pageindex_server.py" --tavern-root .
```

安装依赖完成后，下次只需启动桥接。它监听 `127.0.0.1:17655`，可访问 `http://127.0.0.1:17655/health` 确认状态。检索 API 在回溯面板设置，支持 DeepSeek 和自定义 OpenAI 兼容来源。使用「沿用酒馆」时，酒馆需要已选择可本机访问的 Custom Chat Completion 方案。远程或需要登录的部署可以在扩展内单独配置检索 API。

## Android 原生模式

**手机访问电脑、NAS 或服务器上的酒馆。** 在酒馆主机按上面的步骤启动桥接，再把仓库里的 `server-plugin/floor-recall.mjs` 复制到主机酒馆的 `plugins/`，在该酒馆的 `config.yaml` 打开 `enableServerPlugins: true`，重启酒馆。手机用原来的酒馆地址进入，扩展通过酒馆同源网关访问桥接。网关仅服务 `default-user`。远程使用 HTTPS 时，浏览器也能生成小纪要和结果缓存所需的楼层指纹。普通局域网 HTTP 可检索，指纹相关功能取决于浏览器的安全上下文。

**酒馆也跑在 Android 本机。** 先按官方 Termux 指南安装酒馆。PageIndex 依赖 Linux Python 二进制包，建议在 64 位 Termux 的 Debian proot 中运行桥接。进入 Debian 后安装 `python3 python3-venv git`，把 Termux 中的 SillyTavern 目录绑定进容器，再进入绑定后的目录执行 Linux 步骤。手机浏览器打开 `http://127.0.0.1:8000`。[SillyTavern Android 安装指南](https://docs.sillytavern.app/installation/android-%28termux%29/)

## 数据位置

- 聊天隐藏状态使用酒馆现有的楼层隐藏功能。回溯结论加入本轮发送给正文模型的上下文。
- 原生模式的小纪要保存在 `data/default-user/floor-recall-memories.sqlite3`，每个聊天最多 128 条，总计最多 4096 条。检索结果缓存保存在桥接进程内存中。
- 原生模式的 API 方案保存在 `data/default-user/floor-recall-model.json`。Windows 用当前用户的 DPAPI 保护密钥。Linux/macOS 用同目录、权限为 `0600` 的本机加密密钥 `floor-recall-model.key`。非 Windows 环境迁移时，请妥善保管这两个文件。

本项目是独立的 SillyTavern 实验扩展，依赖 [VectifyAI PageIndex v0.7.4](https://github.com/VectifyAI/PageIndex/tree/v0.7.4)。[酒馆扩展安装文档](https://docs.sillytavern.app/extensions/) · [酒馆服务端插件文档](https://docs.sillytavern.app/for-contributors/server-plugins/)
