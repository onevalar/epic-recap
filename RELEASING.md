# Epic Recap 发版

入口：[GitHub Actions](https://github.com/onevalar/epic-recap/actions)。只允许从 main 运行，不会在每次提交代码时发版。

## 当前配置

2026-10-29 已连接 Google Cloud 项目 `able-math-457002-g0`、专用服务账号和 Chrome 商店发布者 anyujia。GitHub 的 `chrome-web-store` 环境仅允许 main，使用短期身份，不保存私钥。

- [只读身份与 API 连接检查通过](https://github.com/onevalar/epic-recap/actions/runs/40813642902)。当前 API 没有返回 revision 状态，而商店后台显示 0.3.0 正在审核。不能把缺失字段理解成“没有待审核版本”。
- 自动发布遇到状态缺失时会停止。实际上传/提交尚未执行；首次审核结束后，先重新运行“查询审核状态（只读）”，确认 API 返回版本状态，再发布后续版本。

无需重复 Google 授权。下面“Google 授权”部分保留作为重建和维护说明。

## 准备发版

先将代码推送到 main。选择“准备发版” → 点击右上角 Run workflow 展开表单 → 填写后点击表单底部 Run workflow。

- 版本填写 `patch`（如 0.3.0 → 0.3.1）、`minor`（→ 0.4.0）、`major`，也可以填写完整三段版本号。
- 更新说明可填写；留空会从上次已提交版本之后的 Git 提交标题生成草稿，**没有使用 AI 自动推断功能**。
- 默认只准备，不提交商店。确认没有界面、权限和隐私变化的普通更新，可以勾选“检查通过后直接提交商店审核”。

流程会同步 manifest/package/package-lock 的版本，运行单元测试和实际 Chromium 扩展测试，检查导出、恢复与视频，生成 ZIP 和三张 1280×800 JPEG 候选图。全部通过后，才提交版本号到 main、创建 vX.Y.Z 标签及 GitHub 发布草稿。若 main 同时有新提交，会停止，需重新准备。

每次运行都会准备正式版本。未勾选直接提交时，版本、标签和 GitHub 草稿照常生成，商店提交留到“确认发布”。

在运行详情的 Artifacts 下载预览，或在 Releases 查看草稿的说明、ZIP、截图和校验信息。测试页面仅使用合成演示数据。

## 确认发布

检查后运行“确认发布”，输入准备好的完整版本号。

- 如果检测到界面、权限、隐私或商店素材变化，需要在商店后台更新相应内容，再勾选确认。
- `DEFAULT_PUBLISH`：提交审核，通过后自动上架。
- `STAGED_PUBLISH`：提交审核，通过后需要在后台手动上架。
- 商店已有其他版本等待审核/发布时，流程停止，不会自动取消它。
- API 没有返回完整版本状态时，流程也会停止，不会上传；此时到商店后台查看实际状态。
- API 返回相同版本已经提交/发布时不再次上传，可安全重跑以恢复 GitHub 提交记录。
- GitHub Release 的“已提交 Chrome 商店”仅表示提交完成，不代表 Google 已审核通过。审核通知仍使用 Google 邮件和商店状态页。

新截图是实际测试界面的模板排版预览，不会自动替换已批准的 Figma 设计。Chrome Web Store V2 API 没有商店文案和图片编辑接口，需要在后台更新；可以让助手代办。数据用途声明也必须按实际行为核对，不能靠文件差异保证准确。

## 查询审核结果

运行“查询审核状态（只读）”，在运行详情的 Summary 查看结果。它只查询，不上传、不提交、不取消审核；API 未返回信息时会明确提示，请以商店后台为准。这个流程没有定时轮询。

## Google 授权（首次配置）

采用 Google Workload Identity Federation（GitHub OIDC）和专用服务账号，不保存长期私钥。

1. 在 Google Cloud 项目启用 Chrome Web Store API、IAM、IAM Credentials、Security Token Service。
2. 创建专用服务账号 `epic-recap-publisher`，不授予项目级角色。
3. 建立 GitHub OIDC provider，issuer 为 `https://token.actions.githubusercontent.com`，映射 `google.subject=assertion.sub`、`attribute.repository_id=assertion.repository_id`。
4. 条件必须限定数值仓库 ID `1437784855`、owner ID `217557060`、`assertion.ref == 'refs/heads/main'`、subject `repo:onevalar@217557060/epic-recap@1437784855:environment:chrome-web-store`。外部仓库、fork 和其他分支不能使用身份。
5. 只把这个 subject 以 `roles/iam.workloadIdentityUser` 绑定到专用服务账号。
6. Chrome Web Store 开发者 Account 设置中添加服务账号邮箱。**Google 将授权该服务账号管理此发布者名下的项目，无法在此处只限定一个扩展；本工作流固定使用 Epic Recap 的 ID。**
7. GitHub `chrome-web-store` environment 限制仅 main；添加环境变量 `GCP_WORKLOAD_IDENTITY_PROVIDER` 和 `GCP_SERVICE_ACCOUNT`。这些是资源名称，不是密钥。
8. 先运行只读连接检查，再启用正式发布。不要用正在审核的 0.3.0 测试上传。

需要 Google 项目管理权限和一次明确的发布授权。不要把 OAuth token、服务账号 JSON 私钥或账号密码提交到仓库。

## 复用到其他 Chrome 插件

运行 `npm run release:template`，得到 `dist/chrome-extension-release-template.zip`。通用工作流从新项目的 package.json 和 manifest.json 读取包名及展示名称，不再固定为 Epic Recap。

模板包含三条工作流、版本/校验/上传脚本、初始化命令和接入说明；不包含本项目的商店 ID、Google 身份、界面或截图。解压到新插件前先比较同名文件。详细约定见 [模板接入说明](scripts/release/template-guide.md)。

新项目只需要接入自身的测试、构建和截图命令，填写自己的商店扩展 ID，并为仓库配置一次 Google 身份绑定。同一商店发布者可以沿用现有服务账号，但新仓库仍需单独授权；不能直接复制 Epic Recap 的 Google 匹配条件，也不要覆盖旧仓库的绑定。

之后可直接让助手“按 Epic Recap 模板接入这个插件”，提供项目路径、GitHub 仓库和商店扩展 ID。接入完成后的日常操作与这里相同。

官方参考：[服务账号](https://developer.chrome.com/docs/webstore/service-accounts)、[发布 API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)、[GitHub OIDC](https://github.com/google-github-actions/auth)、[GitHub 新版身份标识](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)。
