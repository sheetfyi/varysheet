# 部署指南（Cloudflare Workers + D1 + R2）

## 0. 前置条件

- Node.js 20+，`npm install` 已完成
- 已登录 Cloudflare：`npx wrangler login`（CI / 脚本里改用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` 两个环境变量）
- 账号需可创建 Workers / D1 / R2 资源；**R2 必须先在控制台开通**（Cloudflare 控制台 → Storage & Databases → R2 Object Storage → 开通，需绑定付款方式）。没开通时 `npx wrangler r2 bucket create` 会报 `Please enable R2 through the Cloudflare Dashboard [code: 10042]`，附件上传也就没法工作
- API Token 至少要有 `Account · Workers Scripts · Edit` + `Account · D1 · Edit` + `Account · Workers R2 Storage · Edit` + `Account · Account Settings · Read`（清单与排查见 [6.1](#61-一次性配置-secrets)）

## 1. 创建 D1 数据库并回填 `database_id`

存储拆成了「用户库 + 表格分片库」（见 [docs/storage.md](docs/storage.md)），所以需要**四个** D1 库：

```bash
# 方式一（推荐）：一条命令「按库名查 / 缺了就建」并对齐 wrangler.jsonc，幂等可重跑
node scripts/sync-d1-ids.mjs --create

# 方式二：手工建，再把打印出来的 database_id 抄进 wrangler.jsonc
npx wrangler d1 create cloudnotion-db             # 用户库（DB）
npx wrangler d1 create cloudnotion-tables-trial   # 试用表格分片（DB_TABLES_TRIAL）
npx wrangler d1 create cloudnotion-tables-basic   # 基础表格分片（DB_TABLES_BASIC）
npx wrangler d1 create cloudnotion-tables-pro     # 专业表格分片（DB_TABLES_PRO）
```

`scripts/sync-d1-ids.mjs` 做三件事，顺序就是它的优先级：

1. 环境变量给了 id 就用环境变量（CI 里由仓库 Secrets 提供：`D1_DATABASE_ID` /
   `D1_TABLES_TRIAL_ID` / `D1_TABLES_BASIC_ID` / `D1_TABLES_PRO_ID`）；
2. 否则 `wrangler d1 list --json` 列出本账户的库，**按库名**（`cloudnotion-db` /
   `cloudnotion-tables-trial` / `cloudnotion-tables-basic` / `cloudnotion-tables-pro`）匹配后回填 `wrangler.jsonc`；
3. 本账户里没有这个名字的库、且带了 `--create` 时调 `wrangler d1 create` 现建一个。

因为**换账户 / 重建库之后 `database_id` 一定会变、库名不会变**，这个脚本能直接修好
「`wrangler.jsonc` 里是别的账户的 id」这类问题（CI 的 `deploy` job 跑的就是它）：

```bash
node scripts/sync-d1-ids.mjs --check        # 只看差异、不写文件（需要改时退出码 1）
node scripts/sync-d1-ids.mjs --list d1.json # 离线：读一份 `wrangler d1 list --json` 的结果
```

`wrangler.jsonc` 里默认是占位值（`1111...` / `2222...`）：本地 `--local` 开发可以用占位值，
**部署时必须**是真实值，否则 `wrangler deploy` 会报 `10181 ... which was not found`。

> 表格分片可以按需再加：库快满（默认 85%）时在后台「存储分片」里新建或挂载，
> 见 docs/storage.md 的「后台存储分片」一节；新加的分片不需要改 `wrangler.jsonc`。

## 2. 创建 R2 桶

```bash
npx wrangler r2 bucket create cloudnotion-files
```

> 桶名要与 `wrangler.jsonc` 里 `r2_buckets[0].bucket_name` 一致，改名时同步修改。

## 3. 应用迁移

```bash
npm run db:migrate:remote      # 用户库 + 三个分片库各跑一遍（control / tables 两个目录）
```

本地开发用 `npm run db:migrate:local`（同样是四个库一起）。两个迁移目录各自独立：

- `migrations/control` → 用户库（账号 / 会话 / 设置 / 分片注册表）；
- `migrations/tables` → 每个分片库（表格数据；文件由 `scripts/sync-shard-schema.mjs` 生成）。

`CREATE TABLE IF NOT EXISTS` 部分是幂等的，但 `ALTER TABLE ... ADD COLUMN`（如
`0002_view_shares.sql`、`0003_property_locks.sql`）不可重复执行，交给 `wrangler d1 migrations`
的版本表记录即可；新增迁移在对应目录里按 `00xx_xxx.sql` 命名就会被自动识别，
`deploy.yml` 在部署前会自动执行 `npm run db:migrate:remote`。

> **从旧版本升级（数据还都在一个库里）**：先 `node scripts/migrate-split-data.mjs --remote`
> 把表格数据搬到分片库并核对行数（本地先 `--dry-run` 看数量），确认通过后再跑迁移 ——
> `0012_split_table_storage.sql` 会 DROP 掉用户库里的旧表。完整步骤见 [docs/storage.md](docs/storage.md)。

## 4. 构建并部署

```bash
npm run deploy                 # vite build && wrangler deploy
```

部署成功后会得到 `https://varysheet.<your-subdomain>.workers.dev`（`workers_dev: true`；Worker 名取自
`wrangler.jsonc` 的 `name`，D1 / R2 的名字仍是 `cloudnotion-*` 那套基础设施标识，不受品牌改名影响 ——
那只是**本仓库自己**在用的库名 / 桶名，与其它仓库无关；唯一部署目标就是本仓库
[`sheetfyi/varysheet`](https://github.com/sheetfyi/varysheet)，push 后由 `deploy.yml` 自动部署）。
自定义域名：在 Cloudflare 控制台为 Worker 添加 Custom Domain，或在 `wrangler.jsonc` 增加 `routes`。

> **定时任务**：`wrangler deploy` 会一并注册 `wrangler.jsonc` 里的 `triggers.crons`
> （每天 03:00 UTC 跑一次基础表格的保留期清理，见 `src/worker/retention.ts`）。
> 本地用 `npx wrangler dev --test-scheduled` + `curl "http://127.0.0.1:8787/__scheduled?cron=0+3+*+*+*"`
> 可以手动触发；线上等不及也可以直接调管理员接口
> `POST /api/admin/maintenance/retention`（返回清掉的记录 / 附件数量）。

### 可选环境变量（`wrangler.jsonc` → `vars`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_NAME` | `Varysheet` | 站点名称：前端标题 / favicon / 邮件标题 / 健康检查返回的名称。后台「站点设置」里改过的值优先于它 |
| `MAX_UPLOAD_MB` | `25` | 单文件上传上限（MB） |
| `MAX_DATABASE_RECORDS` | `500` | **基础表格**的记录数上限（专业表格不限）。到上限后只拦「增长」：新建 / 批量新建 / 复制记录一律 `403 capacity_exceeded`，而查看、查询、改已有记录、删记录都不受影响（删掉一些立刻又能新建，见 [README 功能表](./README.md)） |
| `MAX_DATABASE_STORAGE_MB` | `1024` | **基础表格**的附件合计上限（MB，默认 1GB；专业表格不限）。附件上传超过这个总量、或表格已经满员时同样返回 `403 capacity_exceeded`；侧边栏每张表后面的硬盘图标（💾，点开有明细浮层）显示的就是这两项用量 |
| `BASIC_TABLE_RETENTION_DAYS` | `365` | **基础表格**的数据保留期（天）：超过这个时间的记录与附件（含 R2 对象）由定时任务自动清除（`triggers.crons` 每天 03:00 UTC；管理员也可以手动 `POST /api/admin/maintenance/retention`）。专业表格永久保留；设成 `0` 关闭自动清理（只建议本地调试） |
| `ALLOW_SIGNUP` | `true` | 设为 `"false"` 关闭公开注册（已有账号仍可登录） |
| `AUTH_CODE_TTL_MINUTES` | `15` | 注册邮箱确认码有效期（分钟） |
| `AUTH_ECHO_CODE_DOMAINS` | `example.com,example.org,example.net` | 收件人域命中白名单时确认码**不发信**、直接回显在响应里（`devCode`）。这些都是永远收不到邮件的保留测试域，所以不会削弱真实邮箱的验证强度；另外只要没配 `RESEND_API_KEY`，任何邮箱都回显 |

> 机密（`RESEND_API_KEY` / `RESEND_FROM_EMAIL` / `ADMIN_EMAIL` / `ADMIN_PASSWORD`）**不要**写进 `vars`，
> 见第 6.6 节。

## 5. 部署后验证

```bash
# 冒烟测试（288 项断言，覆盖两步注册/登录/建表/记录/视图/分享/成员/附件生命周期（删记录即清 R2）/单表容量（含新建视图）/表格类型与名额/删表不退名额/表格续费/改密码/用户管理/会话兜底）
# 线上跑同一套断言：唯一会改密码的「重置自己密码」只对 @example.* 测试管理员执行，
# 真实 ADMIN_EMAIL 会自动跳过那 2 项（结果 286/286），不会重置你的密码、也不会踢你下线
BASE_URL=https://varysheet.<your-subdomain>.workers.dev node scripts/smoke-test.mjs

# 路由自检
npm run check:routes
```

> 线上跑冒烟测试前，建议先在 Worker 上配好 `ADMIN_EMAIL` + `ADMIN_PASSWORD`（第 6.6 节）：
> 配了就会连「用户管理」一起测（工作流会把仓库里同名的 Secrets 透传给线上冒烟测试；未配置时回落到
> `admin@example.com`，该段自动 `skip`，其余断言照跑 —— 实测这类跑法是 **248/248 checks passed**，
> 不是失败，别误判）。
>
> 工作流跑的就是这套脚本，只是多传两个东西：`SMOKE_EXPECT_BUILD=<commit sha>`（断言线上跑的就是
> 这次部署，读的就是 `/api/health` 的 `build`）和「先等新版本生效」（每 3 秒探一次，最多约 90 秒）。
> `wrangler deploy` 返回时部署已经生效，但边缘上还在跑上一版的实例要几秒才换掉，不等就可能撞上旧版本
> —— 实测被旧版误报过一次失败（刚加的「购买时长白名单」断言被上一版报成 201）。
> 唯一会改数据的断言是「重置自己密码」——它只对 `@example.*` 的测试管理员跑，
> 线上用真实 `ADMIN_EMAIL` 时会自动跳过（不会重置你的密码 / 踢你下线；要强制跑设 `SMOKE_ADMIN_SELF_RESET=1`）。
> 另外注册/重置密码时只有**保留测试域**（`AUTH_ECHO_CODE_DOMAINS`）才会回显确认码，
> 所以线上跑测试要么用 `@example.com` 这类测试邮箱，要么把测试域加到白名单。

浏览器检查：

1. `/` 打开后注册账号：填邮箱 → 「发送确认码」→ 输入 6 位码 → 设密码，注册完直接进空白工作区（新账号不再自动生成表格）
2. 建表 → 加字段 → 加记录 → 切换表格/看板/画廊视图并设置筛选、排序、分组
3. 视图工具栏点「分享」→ 面板里只保留「视图定向分享」：填一个已注册邮箱并选视图 / 权限，对方登录后只能看到被分享的那一个视图（公开链接 `/share/<token>` 接口未改动，生成入口已从界面移除，由冒烟测试覆盖）
4. 上传一个附件字段文件，刷新后仍可下载（验证 R2 绑定）
5. 收起侧边栏（宽屏点侧边栏头部 `«`，手机端点顶部条 ☰ 关掉抽屉）后，顶部条应在站点名与收件箱之间显示当前账号的昵称（用户名 / 邮箱 / 改密码 / 退出仍在侧边栏底部：宽屏点 `«` 展开、手机点 ☰ 拉出抽屉后可见）；点「退出」回到登录页
6. 侧边栏底部的「改密码」：填当前密码 + 新密码 → 成功后其他设备的会话立即失效，本机继续可用
7. 用 `ADMIN_EMAIL` 登录后，侧边栏底部会多出「用户管理」：搜一个已注册邮箱 → 改昵称 / 邮箱 → 「重置密码」应弹出新密码（配了 Resend 时同一份密码也会发到对方邮箱）
8. 侧边栏「我的表格」**上方**应显示「你有 **N** 个表格可」+ 紧挨着的「添加」按钮（同一行）：新账号 N=1；点数字弹出「表格数量说明」（名额规则 + 已用 x/y，还剩几个 + 购买区：表格类型 / 时长单位（月 / 年）/ 时长数量 / 购买数量 + 「购买」按钮，买完立刻加名额）；点「添加」展开输入框，建完一张表数字应减 1；把某个视图分享给另一个账号后再看，数字**不应变化**（分享不再送名额）；**N 减到 0 时「添加」按钮应变灰点不动**
9. **无痕模式 / 手机（Cookie 存不下来）也能正常登录**：这些环境会把 `Set-Cookie` 丢掉，登录（或点邀请链接注册）后应**稳定停在内容页**，不会闪一下又退回登录页 —— 客户端会用响应体里的令牌兜底（存本地 + `Authorization: Bearer`）。想离线复现这条路径：
   ```bash
   # 本地起一个「丢掉 Set-Cookie」的反向代理，用 390x844 手机视口真跑一遍登录（需要本机装了 Edge / Chrome）
   node tools/mobile-check/nocookie-login.mjs "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" http://127.0.0.1:8787 you@example.com <密码>
   ```

## 6. GitHub Actions 自动部署（CI/CD）

仓库内置 `.github/workflows/deploy.yml`：**push 到 `main` 即自动部署**（不需要在网页上点「Run workflow」、
也不需要确认任何选项：校验 → 端到端冒烟测试 → 部署 → 线上冒烟测试 → 把线上地址写成一条 commit status）；
PR 只跑校验与冒烟测试，绝不部署。

| 阶段 | Job | 内容 |
| --- | --- | --- |
| 1 | `verify` | `npm ci` → `npm run typecheck`（client + worker）→ `npm run check:routes` → `npm run schema:check`（分片 DDL 与迁移文件是否同步）→ `vite build` |
| 2 | `e2e` | 本地 D1 迁移（用户库 + 三个分片库） → 后台启动 `wrangler dev --local` → 运行 `scripts/smoke-test.mjs`（断言数见运行日志 / Step Summary） |
| 3 | `deploy` | `node scripts/sync-d1-ids.mjs --create`（按库名对齐四个 D1 库的 id，缺了就现建） → 确保 R2 桶存在 → `npm run db:migrate:remote` → `vite build` → `wrangler deploy --var BUILD_ID=<commit sha>`（给这次部署打批次号，`/api/health` 的 `build` 会返回它） → 同步可选 Secrets → **等新版本真的在线上服务**（轮询 `/api/health` 的 `build`，每 3 秒一次、最多约 90 秒；没等到会以明确错误停下） → 对线上地址再跑一遍完整冒烟测试（比本地多 1 项：目标跑的就是这次部署） → 把线上地址写成一条 commit status（`deploy/cloudflare-workers`，终端 / 提交页就能看到，无需开网页） |

### 6.1 一次性配置 Secrets

仓库 `Settings → Secrets and variables → Actions → New repository secret`：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | ✅ | Cloudflare API 令牌，权限见下 |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | `npx wrangler whoami` 里的 Account ID |
| `D1_DATABASE_ID` | ➖ | 可选。用户库（`DB`）的 id；不填则按库名在本账户里查 |
| `D1_TABLES_TRIAL_ID` | ➖ | 可选。试用表格分片库（`cloudnotion-tables-trial`）的 id；不填则按库名在本账户里查、查不到才现建 |
| `D1_TABLES_BASIC_ID` | ➖ | 可选。基础表格分片库（`cloudnotion-tables-basic`）的 id；不填则按库名在本账户里查、查不到才现建 |
| `D1_TABLES_PRO_ID` | ➖ | 可选。专业表格分片库（`cloudnotion-tables-pro`）的 id；同上 |
| `RESEND_API_KEY` | ➖ | Resend 发信密钥（注册确认码、重置密码通知）。不配则确认码回显，仅适合测试 |
| `RESEND_FROM_EMAIL` | ➖ | 发件人，默认 `Varysheet <admin@varysheet.com>` |
| `ADMIN_EMAIL` | ➖ | 超级管理员邮箱，登录时自动创建 / 提升该账号；默认 `admin@varysheet.com` |
| `ADMIN_PASSWORD` | ➖ | 管理员首次创建时用的密码（8 位以上、含字母与数字） |
| `AUTH_ECHO_CODE_DOMAINS` | ➖ | 逗号分隔的保留测试域（如 `example.com,example.org,example.net`）：这些收件人不真发信，直接把确认码回显在响应里。线上冒烟测试靠它走完两步注册，所以配了 `RESEND_API_KEY`（开始真实发信）之后建议一并配上——只影响白名单里的测试域，真实用户不受影响 |

后 5 个可选 Secret 会在 `deploy` 阶段（部署成功之后）由 `wrangler secret put` 自动写入 Worker，未配置就跳过；
`e2e` 阶段用的是另一套**用完即弃**的本地 `.dev.vars`（`admin@example.com` + 确认码回显白名单），
不会影响线上账号。手动配置与本地开发见 [6.6 邮件（Resend）与超级管理员](#66-邮件resend与超级管理员)。

创建 Token：Cloudflare 控制台 → My Profile → API Tokens → Create Token → 选「Edit Cloudflare Workers」模板，并确保含：

- Account · Workers Scripts · Edit
- Account · D1 · Edit
- Account · Workers R2 Storage · Edit
- Account · Account Settings · Read

（`User · Memberships · Read` 是可选的：只影响 `wrangler whoami` 能不能打印成员角色，缺了只会多一行 warning，与部署无关；同理，用 Account API Token 时 `wrangler whoami` 提示 `Unable to get membership roles` 可以直接忽略。）

未配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 时，`deploy` job 会输出 warning 并**跳过部署**（校验与冒烟测试照常跑），流水线不会变红。

> ⚠️ 若日志在「应用远程 D1 迁移」步骤报 `Authentication error [code: 10000]`，说明 Token 少了 `Account · D1 · Edit`——缺这个权限时连 `npx wrangler d1 list` 都会返回 401（工作流现在会对这种失败输出专门的错误提示，不会只丢一段原始日志）。
>
> 其余常见报错都会被工作流翻译成可读的 `::error title=...`：`[code: 10042]` = 账户还没开通 R2（见第 0 节）；`D1 binding 'DB' references database '...' which was not found [code: 10181]` = `wrangler.jsonc` 里的 `database_id` 不属于本账户（见 6.2）；`[code: 10007] This Worker does not exist on your account` 只在 `wrangler deployments list` 里出现，意思是这个名字的 Worker 还没建过，属正常现象。

### 6.2 首次部署前必须做的一步

`wrangler.jsonc` 里四个 D1 库的 `database_id` 还是占位符、或填的是**别的账户**下的 id 时，
流水线会在 `deploy` 阶段以清晰错误停下（`10181 ... which was not found`）。三种做法：

```bash
# 方案 A（推荐）：一条命令按库名对齐 / 现建（幂等），本地跑完把 wrangler.jsonc 的改动提交
node scripts/sync-d1-ids.mjs --create

# 方案 B：不动代码，把 id 存成 GitHub Secret（工作流优先采用 Secrets 里的 id）
#   D1_DATABASE_ID（用户库）、D1_TABLES_TRIAL_ID、D1_TABLES_BASIC_ID、D1_TABLES_PRO_ID（三个主分片）

# 方案 C：手工建库后回填 wrangler.jsonc
npx wrangler d1 create cloudnotion-db
npx wrangler d1 create cloudnotion-tables-trial
npx wrangler d1 create cloudnotion-tables-basic
npx wrangler d1 create cloudnotion-tables-pro
```

也可以在 Cloudflare 控制台 **Storage & Databases → D1 SQL Database → Create** 建库
（数据库名必须填 `cloudnotion-db` / `cloudnotion-tables-trial` / `cloudnotion-tables-basic` / `cloudnotion-tables-pro`，
工作流是按这些名字建库和执行迁移的），再把列表里的 **Database ID** 回填到 `wrangler.jsonc`
的 `database_id`，或存成上面四个 Secret。

CI 的 `deploy` job 跑的就是方案 A 的那条命令：Secrets 优先 → 按库名查本账户 → 查不到就现建。
所以**换了 Cloudflare 账户**只要 Token 有 `Account · D1 · Edit`，就不用手工抄 id（库名不变，
脚本会把 `wrangler.jsonc` 里过期的 id 自动换成新账户的）。

R2 桶无需手动建，工作流会执行 `wrangler r2 bucket create cloudnotion-files`（已存在则跳过）。

### 6.3 手动触发 / 跳过迁移

Actions → Deploy → Run workflow，可勾选：

- `skip_migrations`：只重新部署代码，不动数据库
- `skip_online_smoke`：跳过部署后的线上冒烟测试（临时排障用）

### 6.4 状态徽章

```md
![Deploy](https://github.com/sheetfyi/varysheet/actions/workflows/deploy.yml/badge.svg)
```

### 6.5 本地复现 CI 全流程

```bash
npm ci
npm run typecheck ; npm run check:routes ; npm run build:client
npm run db:migrate:local
cp .dev.vars.example .dev.vars          # 本地管理员账号 + 测试域回显白名单（冒烟测试要用）
npx wrangler dev --port 8787 --local    # 另开一个终端保持运行
node scripts/smoke-test.mjs             # 期望 242/242 checks passed（.dev.vars.example 里的 admin@example.com 是测试管理员，跑满 242）
```

### 6.6 邮件（Resend）与超级管理员

这两件事都有默认行为，**不配置也能正常跑**：

| 配置项 | 不配置时的行为 |
| --- | --- |
| `RESEND_API_KEY` | 不发真邮件：注册确认码直接回显在 `POST /api/auth/register` 的响应里（`devCode`），仅本地 / 测试域可用 |
| `ADMIN_EMAIL` + `ADMIN_PASSWORD` | 没有超级管理员：`/api/admin/*` 一律 403，界面里也不会出现「用户管理」 |

#### 线上（Worker secret）

```bash
npx wrangler secret put RESEND_API_KEY     # 粘贴 re_... 开头的密钥
npx wrangler secret put RESEND_FROM_EMAIL  # 例：Varysheet <noreply@yourdomain.com>
npx wrangler secret put ADMIN_EMAIL        # 例：you@yourdomain.com
npx wrangler secret put ADMIN_PASSWORD     # 8 位以上、含字母与数字
npx wrangler secret list                   # 确认写入结果
```

也可以只配置 GitHub 仓库的同名 Secrets：`deploy` 阶段部署成功后会由工作流自动 `wrangler secret put`（见 6.1）。

#### Resend 注意事项

- 在 Resend 后台创建 API Key；`RESEND_FROM_EMAIL` 用默认的 `onboarding@resend.dev` 时**只能发到 Resend 账号本人的邮箱**，要发给别人必须先在 Resend 验证自己的域名
- 没配 `RESEND_API_KEY`（或调用失败）只写日志，不会让注册 / 重置接口失败，响应里 `emailed: false`
- 确认码默认 15 分钟有效（`AUTH_CODE_TTL_MINUTES`），同一邮箱 60 秒内只能重发一次（`429`）

#### 超级管理员

- 第一次用 `ADMIN_EMAIL` 登录（或已登录时访问 `GET /api/session`）会自动创建该账号，密码取 `ADMIN_PASSWORD`；账号已存在则**只提升**为管理员，不会改密码
- 忘记密码：临时把 `ADMIN_RESET_PASSWORD` 设为 `true`，再登录一次即用 `ADMIN_PASSWORD` 覆盖，改完记得删掉这个变量
- 管理员能力：用户列表（搜索 + 建表数 / 协作者数 / 最近活跃）、改昵称与邮箱、重置密码（新密码邮件通知本人并作废其全部会话；重置自己时连当前会话一起失效，需重新登录）
- 管理员**看不到**别人的表格内容，也没有删除用户的接口——只能管理账号本身

#### 本地开发

```bash
cp .dev.vars.example .dev.vars      # 模板在仓库根目录；.dev.vars 已 gitignore，切勿提交
npm run dev
```

本地想联调真邮件就把 `RESEND_API_KEY` 填上；只想跑通流程就留空（确认码回显）。
`AUTH_ECHO_CODE_DOMAINS` 里是永远收不到邮件的保留测试域，本地与 CI 冒烟测试都用
`@example.com` 账号，因此能自动读回确认码完成注册。

### 6.7 本机推送固定用 `sheetfyi`（不再弹「选账号」）

GitHub 上挂过多个账号时，Windows 的 Git Credential Manager（GCM）会在 push 时弹窗 / 打开网页
让你挑账号（选了 `sheetfyi` 才能推）。把身份固定住，GCM 会直接用凭据管理器里已有的 `sheetfyi`
凭据，**不再弹任何选择**：

```bash
# 1) 远端 URL 自带用户名：每次 fetch / push 都带上账号提示
git remote set-url origin https://sheetfyi@github.com/sheetfyi/varysheet.git
# 2) 全局再提示一次：以后任何 github.com 仓库都用 sheetfyi
git config --global credential.https://github.com.username sheetfyi
```

验证（禁止交互：能打印出 HEAD 就说明静默可用，不会弹窗）：

```bash
# bash / macOS / Linux
GCM_INTERACTIVE=0 git -c credential.interactive=false ls-remote origin HEAD
# PowerShell
$env:GCM_INTERACTIVE='0'; git -c credential.interactive=false ls-remote origin HEAD
```

凭据真过期时，去掉这两个环境变量手动 push 一次、按提示重新授权即可（账号仍是 `sheetfyi`）。

### 6.8 收款（XorPay，表格名额购买）

在后台填好收款信息就能收款，**不需要重新部署**：

1. 到 [XorPay](https://xorpay.com) 注册并开通（支持个人；开通费 ¥100；微信 / 支付宝任一渠道进件成功即算开通），
   在后台「应用配置」里拿到 **appid** 与 **app secret**；
2. 登录本站 → 侧边栏底部「系统管理」→「站点设置」→ 填 **XorPay 应用 ID（appid）** 与 **应用密钥（app secret）** → 保存设置。
   保存成功会提示「站点设置已保存：微信扫码收款已开启」；
3. 回侧边栏点「你有 N 个表格可」的数字 → 选好类型 / 时长 / 数量 → 点「去支付（微信扫码）」：
   应该出现微信支付二维码；扫码付款后 ≤3 秒名额自动到账（弹窗自己关闭，侧边栏数字 +N）。

要点与排障：

- **默认只开微信扫码**（`native`）。XorPay 那边也开通支付宝之后，用环境变量 `XORPAY_PAY_TYPES=alipay`
  （或 `native,alipay`）就能打开支付宝当面付 —— 代码路径已经就绪，不用改代码。
- **回调地址**是 `{站点域名}/api/xorpay/notify`（下单时写进 XorPay 订单）。回调由 XorPay 的服务器
  （国内）主动打进来，`*.workers.dev` 在国内不稳 —— 建议绑一个自定义域名并把 `PUBLIC_BASE_URL`
  配成它，否则可能「付了钱不到账」（前端轮询会主动查单兜底，但别指望它）。
- 单笔金额上限 **¥1000**（取支付宝当面付个人单笔限额当统一口径），超了会在下单前提示拆单。
- 对账 / 人工处理（在用户库里执行）：

  ```sql
  -- 最近 20 单
  SELECT id, user_id, kind, count, months, amount_cents, paid_cents, status, pay_type,
         aoid, transaction_id, buyer, created_at, paid_at
    FROM table_orders ORDER BY created_at DESC LIMIT 20;
  -- 需要人工处理：实付与订单金额不一致
  SELECT * FROM table_orders WHERE status = 'amount_mismatch';
  ```

- 想给某个账号补名额（客服补偿 / 活动赠送，也是线上冒烟测试发名额用的接口）：
  `POST /api/admin/quota/grants`，body `{ email, kind, count, months, note? }`（管理员会话）。
- 本地想走完整支付链路（不花真钱）：`npm run fake:xorpay` + `.dev.vars` 里的
  `XORPAY_API_BASE=http://127.0.0.1:8788`，然后 `curl.exe -X POST http://127.0.0.1:8788/__pay/<订单号>`
  模拟付款。完整方案（字段口径、签名、验签、幂等、限额、风险清单）见
  [docs/payment-xorpay.md](./docs/payment-xorpay.md)。

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| 部署报 `database_id` 无效 / `10181 ... which was not found` | 库的 id 不属于当前账户：`node scripts/sync-d1-ids.mjs --create`（按库名对齐 / 现建，见 6.2） |
| `wrangler d1 list` / 迁移报 `Authentication error [code: 10000]` | Token 缺 `Account · D1 · Edit`（见 6.1） |
| `npx wrangler r2 bucket create` 报 `Please enable R2 ... [code: 10042]` | 账户还没开通 R2（见第 0 节） |
| `no such table` | 未执行远程迁移：`npm run db:migrate:remote`（用户库与分片库各跑一遍） |
| `no such table: main.notes`（新增 @提醒 / 删账号时） | 用户库里的 `note_mentions` 还带着指向 `notes` 的旧外键：跑一遍迁移（`0013_note_mentions_rebuild.sql`）重建这张表 |
| 表格突然打不开 / 后台提示分片不可用 | 分片库被删或绑定缺失：在后台「存储分片」看状态（启用 / 停用 / 用量），或检查 `wrangler.jsonc` 的 `DB_TABLES_*` 绑定 |
| 分片快满了（后台显示「接近上限」） | 在后台「存储分片」新建一个同类型分片（需要 `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN`），新表格会自动分流过去 |
| 上传报错 / 404 | R2 桶未创建或 `bucket_name` 不一致 |
| `near "values": syntax error` | SQL 中把 `values` 当作列名未加引号；本仓库已统一写成 `"values"` |
| 前端 404 / 空白 | 忘记 `vite build`：`npm run deploy` 会自动构建，勿只跑 `wrangler deploy` |
| 注册收不到确认码 | ① 未配置 `RESEND_API_KEY`（此时只在响应里回显 `devCode`，测试域才能在界面上看到）；② 发件人用了 `onboarding@resend.dev` 但收件人不是 Resend 账号本人；③ 域名未在 Resend 验证。见 [6.6](#66-邮件resend与超级管理员) |
| 登录后没有「用户管理」入口 | 未配置 `ADMIN_EMAIL`，或当前账号不是它；配置后需重新登录（见 [6.6](#66-邮件resend与超级管理员)） |
| 重置自己的密码后被踢下线 | 预期行为：重置自己会作废自己全部会话（含当前），重新用新密码登录即可 |
| 想回滚 | `npx wrangler rollback`（选择上一个版本，见 `npx wrangler deployments list`） |

## 8. 数据备份

```bash
# 导出线上库（SQL 文本）：用户库 + 每个表格分片库
npx wrangler d1 export cloudnotion-db --remote --output backup-user.sql
npx wrangler d1 export cloudnotion-tables-trial --remote --output backup-tables-trial.sql
npx wrangler d1 export cloudnotion-tables-basic --remote --output backup-tables-basic.sql
npx wrangler d1 export cloudnotion-tables-pro --remote --output backup-tables-pro.sql
```

后台新建的备用分片（后台「存储分片」里挂载的库）也要各自导出：库名与 `database_id`
在后台那一页的列表里能看到。
