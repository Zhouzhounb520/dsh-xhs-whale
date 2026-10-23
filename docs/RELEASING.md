# 发布到 GitHub

项目仓库：[Zhouzhounb520/dsh-xhs-whale](https://github.com/Zhouzhounb520/dsh-xhs-whale)。仓库简介可写：基于 DeepSeek 与 xiaohongshu-mcp 的本地小红书阅读助手，支持图文精读、草稿审核与小鲸鱼互动。

## 生成源码包

```powershell
node --test test/*.test.js
.\scripts\打包发布.ps1
```

Node 不在 PATH 时可为脚本指定 -NodeExe。脚本在 dist/ 创建新的带时间戳目录、ZIP 和 ZIP 的 SHA256 文件，不覆盖现有包。ZIP 内包含一个顶层项目目录；解压后即可作为仓库根目录。

打包工具只选择约定的源文件目录和根文件，拒绝符号链接、私密文件名及常见密钥格式。SOURCE-MANIFEST.json 记录各文件的 SHA256。白名单之外的文件不会自动加入发布；新增目录时应修改 tools/release-files.mjs 并审核。

打包并不代替测试。发布前还应运行 Windows 启动辅助函数测试和 Go 构建，检查新版本说明，并人工查看包内文件。

## 创建仓库

在 GitHub 创建空仓库，将解压后的项目目录内容作为仓库根目录。使用 Git 时，在该干净目录执行：

```text
git init
git add .
git commit -m "Initial public release"
git branch -M main
git remote add origin <你创建的仓库地址>
git push -u origin main
```

不要对包含历史运行数据的工作目录执行未经检查的 git add。使用 GitHub 网页上传时，上传源码文件和目录；ZIP 可以另外放到 Release 附件，不要只把 ZIP 当作仓库源码。

提交后 Actions 会运行离线检查和 Windows 服务构建。可在验证通过后创建 v0.2.0 标签和 Release，附上 ZIP、SHA256 以及 CHANGELOG 对应条目。

## 不应发布的内容

data、vendor、output、test-results、私人日记、登录 Cookie、API Key、账号配置、实际互动记录、本机命令入口、生成截图和可执行文件。上游修改版源码位于 upstream，须连同 Apache-2.0 许可证和修改说明一起发布。

若密钥曾进入公开提交，仅删除文件不足以撤销泄漏，应撤销对应凭据并清理历史。不要把真实凭据放进测试夹具。
