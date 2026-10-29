# Chrome 插件发布流程

这份模板提供版本管理、GitHub 发布草稿、ZIP 校验、商店上传和审核状态查询。它不包含来源项目的商店 ID、Google 身份、产品界面或截图。

## 适用范围

已有 GitHub main 分支、根目录 manifest.json、package.json 和 package-lock.json 的 Manifest V3 插件。采用三段版本号，package.json.name 使用小写英文、数字和短横线，例如 my-extension。名称用于 ZIP 文件名，manifest.name 用于发布标题。

这是后续版本的发布流程。先在 Chrome 商店建立项目并完成首次提交，拿到扩展 ID。API 必须能返回完整版本状态，后续自动上传才会执行；首次提交尚在审核时，先等待审核。

## 一次性接入

1. 在新插件的分支中解压并合并模板文件。已有同名工作流、脚本或测试时先比较，不直接覆盖。vendor 中的 fflate 文件必须保留 LICENSE。
2. 配置下面四个项目脚本，使用插件自身的构建、测试与截图逻辑。模板不会把别的插件的测试或截图套进来。
3. 确认 package.json / package-lock.json / manifest.json 版本一致，Playwright 在 package.json 和 lockfile 中固定为完整版本号。
4. 在插件根目录运行：

   ```sh
   node scripts/release/configure.mjs 发布者ID 扩展ID 上次提交商店的完整Git提交SHA
   ```

   该命令生成 .release/store.json、.release/baseline.json，添加公共 npm 命令；配置已存在时拒绝覆盖。它不会改动版本、创建 Google 权限或上传商店。

5. 将 dist/ 加入 .gitignore。提交这些配置到 main。
6. 为新仓库配置 Google 身份和 GitHub 环境，运行“查询审核状态（只读）”验证连接。

## 项目脚本约定

| npm script | 必须完成的工作 |
| --- | --- |
| test | 该插件的单元测试；失败时返回非零状态 |
| test:browser | 实际 Chromium 扩展测试；工作流已安装 Playwright Chromium，建议使用 channel: chromium；截图及测试结果写入 ARTIFACT_DIR |
| package:store | 按明确的运行文件清单构建插件，使用更新后的根目录 manifest.version，输出 dist/包名-版本-chrome-web-store.zip，ZIP 根目录为 manifest.json；排除源码仓库、密钥和测试产物 |
| release:screenshots | 从实际插件界面生成适合该产品的截图，写入 dist/release/screenshots/；仅作为候选图，不自动改动商店 |

公共脚本负责同步版本、汇总 Git 提交标题、检查 ZIP 的版本和 SHA-256。它不会验证每种构建系统的资源是否完整，项目自身测试和打包脚本需要覆盖这些检查。Vite、WXT、Plasmo 等项目还需把根目录 manifest 的版本传入构建配置。

## Google / GitHub 授权

同一 Chrome 商店发布者可以沿用已绑定的服务账号。Google 当前每个发布者仅支持绑定一个服务账号，不要为新插件替换掉旧绑定。[官方说明](https://developer.chrome.com/docs/webstore/service-accounts)

新仓库仍需单独授权。为它创建单独的 Workload Identity provider 或 pool，匹配它的数值 repository_id、repository_owner_id、refs/heads/main 和 chrome-web-store environment subject，再将该身份绑定到现有服务账号。不要把现有仓库的 Google 匹配条件直接改成新仓库，否则旧插件会失去访问能力；也不要放宽成整个账号通配。

先通过 GitHub API 查询新仓库的实际 subject 配置：GET /repos/OWNER/REPO/actions/oidc/customization/sub。新仓库一般使用含数值 ID 的 immutable subject，不能照抄旧仓库名称。[GitHub 说明](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)

GitHub 中创建 chrome-web-store environment，只允许 main。设置环境变量 GCP_WORKLOAD_IDENTITY_PROVIDER 和 GCP_SERVICE_ACCOUNT。不要存放长期私钥。新仓库获得发布能力属于新增授权，应由账号所有者确认后再配置。

## 日常发布

先推送代码到 main。打开 Actions → 准备发版 → Run workflow，填写 patch / minor / major / 完整版本号和更新说明。默认生成正式的版本提交、标签和 GitHub 发布草稿；勾选直接提交后，检查通过会自动提交商店审核。

涉及插件代码、界面、权限、隐私或素材变化时会要求人工核对。完成商店资料更新后，运行“确认发布”，填写已准备的版本并勾选确认。文件匹配只是提示，不能代替检查真实数据用途；新架构或其他语言需调整 scripts/release/lib.mjs 的 reviewFlags。

DEFAULT_PUBLISH 表示审核通过后自动上架，STAGED_PUBLISH 表示通过后在后台手动上架。存在其他待审核版本，或 API 状态缺失时停止上传。提交审核不等于通过审核。

截图、商店介绍和隐私声明仍在商店后台更新。GitHub 发布说明不会自动写入商店介绍。
