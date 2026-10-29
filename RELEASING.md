# Epic Recap 发版

入口：[GitHub Actions](https://github.com/onevalar/epic-recap/actions)。只允许从 main 运行，不会在每次提交代码时发版。

## 准备发版

选择“准备发版” → Run workflow。

- 版本填写 `patch`（如 0.3.0 → 0.3.1）、`minor`（→ 0.4.0）、`major`，也可以填写完整三段版本号。
- 更新说明可填写；留空会从上次已提交版本之后的 Git 提交标题生成草稿，**没有使用 AI 自动推断功能**。
- 默认只准备，不提交商店。确认没有界面、权限和隐私变化的普通更新，可以勾选“检查通过后直接提交商店审核”。
- “仅演练”只生成下载包和预览，不推送版本、不创建 GitHub Release，也不访问商店 API。

流程会同步 manifest/package/package-lock 的版本，运行单元测试和实际 Chromium 扩展测试，检查导出、恢复与视频，生成 ZIP 和三张 1280×800 JPEG 候选图。全部通过后，才提交版本号到 main、创建 vX.Y.Z 标签及 GitHub 发布草稿。若 main 同时有新提交，会停止，需重新准备。

在运行详情的 Artifacts 下载预览，或在 Releases 查看草稿的说明、ZIP、截图和校验信息。测试页面仅使用合成演示数据。

## 确认发布

检查后运行“确认发布”，输入准备好的完整版本号。

- 如果检测到界面、权限、隐私或商店素材变化，需要在商店后台更新相应内容，再勾选确认。
- `DEFAULT_PUBLISH`：提交审核，通过后自动上架。
- `STAGED_PUBLISH`：提交审核，通过后需要在后台手动上架。
- 商店已有其他版本等待审核/发布时，流程停止，不会自动取消它。
- API 返回相同版本已经提交/发布时不再次上传，可安全重跑以恢复 GitHub 提交记录。
- GitHub Release 的“已提交 Chrome 商店”仅表示提交完成，不代表 Google 已审核通过。审核通知仍使用 Google 邮件和商店状态页。

新截图是实际测试界面的模板排版预览，不会自动替换已批准的 Figma 设计。Chrome Web Store V2 API 没有商店文案和图片编辑接口，需要在后台更新；可以让助手代办。数据用途声明也必须按实际行为核对，不能靠文件差异保证准确。

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

官方参考：[服务账号](https://developer.chrome.com/docs/webstore/service-accounts)、[发布 API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)、[GitHub OIDC](https://github.com/google-github-actions/auth)。
