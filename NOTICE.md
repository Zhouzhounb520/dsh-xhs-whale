# 来源与依赖

- 工作流与养鱼结构参考并改编自 [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)，采用 MIT 许可证，原版权许可保存在 [licenses/dsh-bili-whale.LICENSE](licenses/dsh-bili-whale.LICENSE)。本项目针对小红书实现阅读工作台、存储、调度和命令行。
- 平台操作基于 [xpzouying/xiaohongshu-mcp v2.5.5](https://github.com/xpzouying/xiaohongshu-mcp/tree/v2.5.5)，采用 Apache-2.0。修改版源码及原许可证保存在 [upstream/xiaohongshu-mcp](upstream/xiaohongshu-mcp)，修改范围和打包裁剪见其中 MODIFICATIONS.md。此目录不受根目录 MIT 许可证替代。
- Windows 安装脚本另行下载该版本的官方登录程序与服务，验证固定 SHA256。本项目自己编译的 checked 程序属于本地修改版本，不是上游官方发行物。浏览器、Go 工具链及模块依赖保持各自的许可证，均不随源码 ZIP 打包。
- 模型请求使用 [DeepSeek API](https://api-docs.deepseek.com/)。模型名称、能力与接口可变化。
