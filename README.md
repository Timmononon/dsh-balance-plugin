# DSH Balance

一个用于 DeepSeek Harness（DSH）WebUI 的本地余额插件。在页面右下角加入“余额”按钮，集中显示：

- DeepSeek 官方 API 余额；
- CLIProxyAPI（CPA）中的 Codex 账号套餐、订阅到期时间、剩余额度和额度重置时间；
- 按实际窗口时长识别的 5 小时、日、周和月额度。

界面采用紧凑的黑白配色，支持浅色/深色模式、打开/关闭动画、全部刷新、分区刷新和单账号刷新。按钮会检测右下角的其他交互元素并自动向上避让。

## 环境要求

- DeepSeek Harness WebUI；
- Node.js 提供原生 `fetch`；
- 如需 CPA 额度：本机正在运行 CLIProxyAPI，默认管理地址为 `http://127.0.0.1:8317`。

当前已验证环境：DSH `0.1.0-rc.8`、CLIProxyAPI `7.2.120`。

## 从 GitHub 安装

在 PowerShell 中执行：

```powershell
dsh plugin --profile web add github:Timmononon/dsh-balance-plugin
```

安装后重启 `dsh web`，刷新 WebUI，即可在右下角看到“余额”按钮。

开发时也可以从本地源码目录安装：

```powershell
dsh plugin --profile web add C:\path\to\dsh-balance-plugin
```

插件应通过 DSH 的 profile 安装，不要复制到 DSH 的全局 npm 安装目录；全局目录中的内容可能在 DSH 更新时被覆盖。

## 升级与卸载

升级到 GitHub 上的最新版本：

```powershell
dsh plugin --profile web update dsh-plugin-deepseek-balance
```

卸载：

```powershell
dsh plugin --profile web remove dsh-plugin-deepseek-balance
```

执行后请重启 `dsh web`。

## 凭据与配置

插件默认通过 DSH 凭据服务读取：

- `DEEPSEEK_API_KEY`：DeepSeek 官方 API Key；
- `CPA_MANAGEMENT_KEY`：CPA 管理页面使用的管理密钥。

CPA 管理密钥未配置或填写错误时，可在余额弹窗内重新填写。密钥提交给本机 DSH 后写入其凭据服务，不会保存在浏览器的 Local Storage 中。

默认配置位于 `cordis.patch.yml`：

```yaml
apiKeyEnv: DEEPSEEK_API_KEY
endpoint: https://api.deepseek.com/user/balance
cpaBaseUrl: http://127.0.0.1:8317
cpaManagementKeyEnv: CPA_MANAGEMENT_KEY
cacheSeconds: 30
refreshCooldownSeconds: 15
```

`cacheSeconds` 控制普通查询的缓存时间；`refreshCooldownSeconds` 用于避免连续点击刷新时过于频繁地请求上游接口。

## 安全说明

- 余额和额度接口仅接受来自本机回环地址的请求；
- CPA 管理密钥写入还会验证 WebUI 同源，降低跨站请求风险；
- DeepSeek API Key 和 CPA 管理密钥只在服务端使用，不会返回给前端；
- 查询失败时保留上次成功数据，并明确标记数据可能已过期；
- 请勿把 `.env`、密钥、未脱敏账号截图或本机凭据文件提交到仓库。

## 开发与测试

```powershell
npm test
node --check src\index.js
node --check src\client.js
```

## 免责声明

本项目是非官方社区插件，与 DeepSeek、DeepSeek Harness、OpenAI 或 CLIProxyAPI 的维护方无隶属或背书关系。上游接口或数据结构变更时，额度展示可能需要相应更新。

## License

[MIT](LICENSE)
