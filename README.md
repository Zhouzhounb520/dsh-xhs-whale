# 小鲸鱼 · 小红书阅读助手

[![Offline checks](https://github.com/Zhouzhounb520/dsh-xhs-whale/actions/workflows/ci.yml/badge.svg)](https://github.com/Zhouzhounb520/dsh-xhs-whale/actions/workflows/ci.yml)

[使用说明](docs/USAGE.md) · [配置说明](docs/CONFIGURATION.md) · [架构说明](docs/ARCHITECTURE.md) · [问题反馈](https://github.com/Zhouzhounb520/dsh-xhs-whale/issues)

在本机运行的 DeepSeek 图文阅读工作台，也可以作为 DSH（DeepSeek Harness）插件，为小鲸鱼设置人设、作息和互动方式。

灵感来自 [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)，平台操作基于 [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)。当前版本 **0.2.0 · 实验版**，面向 Windows x64。

## 功能

2026-10-26 更新：自然口语与情境表达学习、真实 @ 主人互动、累计留言触发的自动回访。详见 [变更记录](CHANGELOG.md) 和 [使用说明](docs/USAGE.md)。

| 模块 | 当前能力 |
| --- | --- |
| 发现与阅读 | 关键词搜索、首页推荐、临时兴趣与排除词、正文和评论读取、图文精读 |
| 个性与作息 | 小鲸鱼人设、随机唤醒窗口、每段最低醒来次数、两本本地日记 |
| 内容偏好 | 北京等城市关键词优先、近期内容优先；城市、主题可修改 |
| 聊天口吻 | 按情境使用自然短句、可爱颜表情与鲸鱼特色；通过私人日记参考真实表达和反馈，不强制卖萌 |
| 评论与回复 | 生成草稿、人工审核；开启发送后可按养鱼策略评论、回复 |
| 点赞与分享 | 按设置点赞；使用修改版服务选择平台真实 @ 主人候选 |
| 评论收件箱 | 区分自己、主人、其他用户；陌生人默认进入草稿 |
| 评论回访 | 同一人在小鲸鱼自己的帖子下累计两条留言后，精读对方最新作品，预览核验后自动点赞并留言 |
| 验证处理 | 发现登录或验证问题后暂停，提供本人操作验证的流程 |
| 演示模式 | 虚构笔记、固定分析，不调用模型、不连接真实账号 |

视频笔记目前只读取可用正文和附图，不包含视频播放理解。平台页面变化可能影响搜索、评论定位和 @ 候选；无法确认发送结果时保留“需核对”状态，不自动重发。

## 先试用演示

安装 **Node.js 22 或以上**，下载源码并进入项目目录：

```powershell
git clone https://github.com/Zhouzhounb520/dsh-xhs-whale.git
cd dsh-xhs-whale
node tools/xhs.mjs serve --demo
```

也可以点击仓库 **Code → Download ZIP**，解压后在项目目录打开终端，从最后一条命令开始运行。

打开 <http://127.0.0.1:18062>。JavaScript 部分没有第三方运行依赖，无需 npm install。按 Ctrl+C 停止。

## Windows 完整安装

需要 Windows x64、Node.js 22+、**Go 1.24+**、PowerShell 5.1 或 7。首次安装需联网下载 GitHub 发布文件、Go 依赖与浏览器。Go 依赖若要求更新工具链，默认 Go 工具链机制可能继续下载。

在项目根目录运行：

```powershell
# 下载固定版本的登录工具和官方服务，检查 SHA256，再构建本项目修改版
.\scripts\安装小红书服务.ps1

# 扫码登录并启动服务；成功后登录窗口自动关闭是正常现象
.\scripts\启动小红书服务.ps1 -Login

# 在另一个终端启动阅读工作台
node tools/xhs.mjs serve
```

打开 <http://127.0.0.1:18061>，在“连接设置”中：

1. 服务地址保留 `http://127.0.0.1:18060`，默认无需服务令牌。
2. 检查登录账号，填写自己的 DeepSeek API Key，测试模型连接。
3. 设置感兴趣的内容，先运行一次筛选和阅读。
4. 确认要使用公开互动功能时，再打开发送开关，并设置主人身份和回复策略。

密钥也可以通过 `DEEPSEEK_API_KEY` 环境变量提供。若使用配置文件，将 `.env.example` 复制为 `.env` 后运行：

```powershell
node --env-file=.env tools/xhs.mjs serve
```

普通启动不会自动加载 `.env`。本项目使用独立 API Key，不复用 DSH 的登录令牌。当前代码提供的模型选项与图像处理方式见 [配置说明](docs/CONFIGURATION.md)。

日常启动服务可双击根目录的 `启动小红书服务.cmd`；需要重新登录时运行：

```powershell
.\scripts\启动小红书服务.ps1 -Login -Restart
```

如果脚本被 PowerShell 执行策略阻止，可在审阅源码后，仅为当前终端设置 `Set-ExecutionPolicy -Scope Process Bypass`。不要更改整机策略。

## 可选：接入 DSH 养鱼

独立工作台可以阅读、生成草稿和审核发送；随机唤醒的智能体会话依赖 DSH 保持运行。

```powershell
# 将路径替换为自己安装的 DSH 程序
.\scripts\安装DSH插件.ps1 -DshExe 'C:\Apps\DSH\DeepSeek Harness.exe'
```

重启 DSH，打开“小红书阅读”设置和养鱼页面；找到 `xhs-whale` 会话，按 DSH 的权限机制允许其执行本地项目命令。先运行“启动测试”，再配置作息、人设和互动方式。插件安装方式依赖 DSH 的桌面插件接口，版本变化时可能需要调整。

- 每段默认至少醒来 1 次；关机或关闭 DSH 时不会执行，也不在窗口外补醒。
- 主人身份需要配置；真实 @ 还需要开启提及开关并匹配到平台候选，手打文本不等于真实提及。
- 陌生人默认只生成草稿，主人直回也受发送主开关约束。
- 回访按不同评论 ID 累计，可跨帖子，其他人留言不清零；不抽概率，同一作品不重复留言。发送主开关、点赞开关和点赞额度仍适用。
- 人设规则在 [fish/AGENTS.md](fish/AGENTS.md)，详细操作见 [使用说明](docs/USAGE.md)。

## 项目结构

```text
lib/                         工作台服务、模型调用、流程、养鱼与调度
public/                      本地网页
tools/                       命令行与源码打包工具
scripts/                     Windows 安装、构建、启动与打包脚本
fish/AGENTS.md               小鲸鱼人设和操作规则
test/                        离线回归测试
upstream/xiaohongshu-mcp/     Apache-2.0 修改版服务源码与变更说明
docs/                        使用、配置、发布文档
data/                        本机运行时生成，不发布
vendor/                      下载工具、构建产物、缓存，不发布
```

## 开发与验证

```powershell
node --test test/*.test.js
.\test\start-service.ps1
.\scripts\构建评论修复版.ps1
```

构建脚本支持 `-GoExe`、`-GoProxy` 和 `-OutputDir`。修改版服务默认输出到 `vendor/`，并生成启动时核验的 `checked-build.json`。不要在服务运行时覆盖其程序；需要只验证构建时可指定独立输出目录。

GitHub Actions 执行 JavaScript 回归测试、演示模式检查、Windows 启动辅助函数测试、Go 本地回归及 Windows 服务编译。测试不使用真实账号，不发布评论。它们不代表平台实时链路始终可用。

## 发布与数据

运行 `.\scripts\打包发布.ps1` 生成可发布的源码 ZIP，详见 [发布说明](docs/RELEASING.md)。

发布包采用文件白名单，排除 API Key、Cookie、个人账号配置、日记、真实互动记录、截图、运行日志、下载程序和缓存。测试样例使用虚构账号。工作台数据仍留在你自己的 `data/`，请妥善保存。

Ciallo～(∠・ω< )⌒★

## 来源与许可

本项目原创部分使用 [MIT](LICENSE)，修改版小红书服务使用 [Apache-2.0](upstream/xiaohongshu-mcp/LICENSE)。来源和修改范围见 [NOTICE.md](NOTICE.md)。
