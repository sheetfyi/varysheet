# Varysheet

![Deploy](https://github.com/sheetfyi/varysheet/actions/workflows/deploy.yml/badge.svg)

> 站点名称（品牌）：**Varysheet**，随时可在**后台 → 站点设置**里改（站点名称 / 站点图标 / 管理员邮箱 /
> Resend 密钥与发件人，见 `src/worker/settings.ts`）。生效顺序是 **数据库 → `wrangler.jsonc` 的
> `vars.APP_NAME` 等环境变量 / Worker secret → 代码里的默认值**：老部署不改配置也能跑，改完后台即时生效。
> 站点名称同时决定前端标题、favicon、注册 / 重置邮件标题；`/api/health` 的 `app` 字段只读环境变量 /
> 代码默认值（不查库，改后台站点名称不会改变健康检查的输出）。
> Cloudflare 侧的**基础设施标识仍沿用 `cloudnotion`**（Worker 名 `cloudnotion` → 线上地址 `cloudnotion.<subdomain>.workers.dev`、D1 库 `cloudnotion-db`、R2 桶 `cloudnotion-files`）：
> 这些名字一旦变动就等于换线上地址 / 换库，数据不会自动跟着走，所以按品牌改名时保持不动。

类 Notion 的灵活表格（Database）系统，全部跑在 **Cloudflare Workers + D1 + R2** 上：

- 后端：单个 Worker（`src/worker/index.ts`），自研路由 + D1（SQLite）持久化 + R2 附件存储
- 前端：React 19 + Vite 单页应用（`src/client`），构建产物由 Workers 静态资源（Assets）托管，`/api/*` 优先交给 Worker，其余走 SPA fallback
- 无第三方运行时依赖（除 React），无 ORM，SQL 直写

## 功能

| 模块 | 说明 |
| --- | --- |
| 账号 | 邮箱 + 密码注册/登录/登出，HttpOnly Cookie 会话（DB 只存 token 哈希）；**注册分两步**：先发 6 位邮箱确认码（`POST /api/auth/register` 返回 202 + `codeTtl`），验证码通过才写入 `users`，所以**没确认过的邮箱不会占号**；登录后在侧边栏底部「改密码」凭当前密码自行修改（作废其他设备的会话、当前设备保留）；用户名 / 邮箱 / 退出平时在侧边栏底部，侧边栏收起（手机端抽屉关闭）时挪到右上角顶部条；**新账号从空白开始**：不再自动生成「我的第一个表格」或任何示例数据，需要时自己在侧边栏新建表格；**Cookie 存不下来的浏览器也能正常登录**：无痕模式、被拦截的 Cookie、部分 App 内嵌浏览器会把 `Set-Cookie` 丢掉（表现就是「登录成功后又被退回登录页」），所以客户端在登录 / 邀请注册成功后会先问一次 `/api/session` 确认会话真的落地 —— 没落地就用同一个密码带 `tokenInBody` 再登一次，把令牌存在本地并用 `Authorization: Bearer` 继续访问（服务端 cookie 优先、令牌兜底） |
| 站点设置 | 顶部「后台」页面第一块：站点名称（≤60 字，界面上就是侧边栏 / 顶部条的标识 + 浏览器标题 + favicon）、站点图标（PNG / JPEG / WebP / GIF / AVIF / SVG / ICO，≤512KB，存 R2）、管理员邮箱、Resend 密钥与发件人。Resend 密钥只以掩码（`re_ab…wxyz`）回传，输入框没聚焦过就不会提交；留空保存 = 删掉数据库里的值、退回 Worker secret / 默认值 |
| 用户管理 | 仅供 `ADMIN_EMAIL`（或后台「站点设置」里改过的管理员邮箱）指定的超级管理员（首次登录自动创建 / 提升，见 [DEPLOY.md 6.6](./DEPLOY.md)）：侧边栏底部的「用户管理」面板支持按邮箱 / 昵称搜索 + 分页，显示建表数 / 协作者数 / 最近活跃时间，可改昵称与邮箱，也可一键重置密码（新密码邮件通知本人并作废其全部会话；重置自己时连当前会话一起失效，需重新登录）；**第一列是复选框**，勾选后可「删除选中」批量删除账号（连同他拥有的表格、记录、备注、上传文件一起清理；自己与其它管理员会被跳过并提示原因） |
| 表格 | 多表格（Database）管理、图标/描述、**新建即空白表格**（只有「名称」字段，弹窗里不再让用户挑模板）、软删除归档。表格分**基础表格 / 专业表格**两类（`databases.kind`），新建时在侧边栏的表单里选 |
| 表格名额 | 侧边栏「我的表格」**上方**两行：基础表格「你有 **N** 个基础表格可」+ 紧挨着的「添加」按钮，下面一行是「专业表格可添加 **M** 个」。**两类名额分开算**：新注册账号默认 **0 个**（原来送 1 个基础表格，已取消），每分享一次表格（视图定向分享 / 公开链接 / 协作者）对应类型的名额 +1；也可以**直接购买**（弹窗里选类型 + 数量，`POST /api/quota/purchases`，买几个就多几个，服务端立刻写一条购买流水并生效 —— 支付网关还没接入）。点数字弹出「表格数量说明」：三条规则 + 两张表的「已添加 / 共几个名额 / 还剩几个」+ 基础表格 / 专业表格的功能对比 + 购买区。新建表格表单里选类型（某一类没有名额时那一项置灰）；两类合计剩 0 时「添加」按钮置灰。数字来自 `GET /api/quota`（登录时随会话一起下发，建表 / 分享 / 删表 / 购买后自动刷新），口径见 `src/shared/quota.ts`；**服务端在 `POST /api/databases` 硬拦**：对应类型名额用完返回 `403 quota_exceeded` |
| 字段 | 16 种字段类型（文本/数字/单选/多选/状态/日期/勾选/链接/邮箱/电话/附件/创建时间/更新时间/创建人/更新人），可重命名、改宽、拖动排序、类型转换时清洗数据；表头 `▾` 菜单支持「编辑 / 升序 / 降序 / 添加筛选 / 在右侧插入 / ← → 左右移动该列 / 隐藏字段 / 锁定字段 / 删除字段」；**升序 / 降序是单键排序**：视图里只保留一条排序规则，对某个字段升 / 降序会自动取消其他字段的排序，当前排序字段在表头显示 ↑ / ↓；表格末尾不再显示「＋ 字段」列，新增字段统一走表头 `▾` 菜单的「＋ 在右侧插入」 |
| 记录 | 新建/编辑/删除、批量创建、批量删除、复制记录、分页（`limit`/`offset`，**滚动到底自动加载下一页**：表格 / 看板 / 画廊三种视图通用，原来表格右上角的「加载更多」按钮已移除）、乐观更新 + 失败回滚；行末的「复制记录 / 删除记录」操作列已移除，复制 / 删除统一走**批量操作栏（已选 N 条 / 复制 / 删除 / 取消选择）**，它显示在「＋ 新建筛选」后面的视图工具栏里；行首的方框列不再吸边，跟着表格一起左右滚动 |
| 视图 | **新建视图固定为表格类型**（弹窗里不再让用户选类型；表格 / 看板 / 画廊三种类型依然都能正常渲染，看板、画廊来自示例数据或历史数据），支持筛选（**按「必须满足」块分组**：「＋ 添加必须满足块」可以加任意多个块，块与块之间是「且」；每个块里用「＋ 添加任意满足」加任意多条条件，命中任意一条就算这一块通过。所以 `(A 或 B) 且 (C 或 D)` = 块 1（A / B 任意满足）+ 块 2（C / D 任意满足）。老视图只带视图级 `conjunction` 时行为不变：`or` = 单块全「或」，`and` = 每条各成一块）、排序（单键）、隐藏字段、行高/卡片大小，全部配置存 D1；视图设置（行高 / 卡片大小 / 卡片预览字段 / 显示的字段）与重命名、删除统一收在最右边的「⋯」菜单里（原来独立的「设置」按钮已并进去，右侧只剩「分享」和「⋯」）；`config.groupBy` 字段仍保留（老数据与模板建表会写入，看板列 / 表格分组照旧渲染），只是界面上不再有「分组依据」入口 |
| 协作 | 成员分为 `editor`/`viewer`，所有者始终排在成员列表首位且不可被移除（邀请 / 改角色 / 移除的接口保留在后端，界面已移除管理入口） |
| 实时同步 | **多人协作不用刷新页面**：每一次改动（改单元格 / 增删记录 / 新增备注 / 改结构）都会记一条带自增版本号的日志（`database_changes`），表格页开着的时候每 5 秒带 `?since=<rev>` 拉一次增量（`GET /api/databases/:id/changes`），只把别人改过的行就地合并进本地表格并**高亮闪一下变了的格子**，被删掉的行自动消失；记录卡片仍额外每 20 秒同步一次（`GET /api/records/:id`）。标签页切回前台时立刻补一次；本地正在写入时那一轮先跳过（不会把刚改的值顶回去）；服务端说改动太多 / 结构变了（`reset`）就整表重载一次。公开链接页（`/share/:token`）走同一套增量接口 `/api/public/:token/changes` |
| 锁定 | 只读控制只剩**字段锁定**（表头 `▾` 菜单里锁定，该字段所有记录只能查看，编辑与附件上传都会被服务端拒绝）。**视图锁定已在客户端整体下线**：「⋯」里的「锁定视图」项和「＋ 新建视图」表单里的「锁定该视图」勾选都已移除；服务端 `views.is_locked` 依然保留以兼容老数据 —— 老的锁定视图打开后只显示「🔒 视图已锁定」提示，没有改名 / 设置 / 删除入口，服务端的写操作拦截照旧生效。表级「表格锁定」已移除：`PATCH /api/databases/:id` 里的 `locked` 会被忽略，字段结构只受访问权与定向分享限制 |
| 分享 | **视图定向分享**：把单个视图（含它的筛选与可见字段）分享给已注册账号，打开面板的入口是视图工具栏的「分享」；公开链接 `/share/:token`（只读 / 可编辑、可设 7/30/90 天过期，写操作走 `/api/public/*`）接口保留，界面已移除生成入口。**限制编辑**（公开链接的 `limitEdits`、视图定向分享里的勾选项）下输入次数不限，只是每次保存成功（= 这一格有内容）后要等 **10 秒计时窗口**才会锁上：窗口内想改多少遍都行、每次保存重新计时；窗口一到且这一格仍有内容就只读；而在这 10 秒内把内容清空等于「没输入过」—— 记账一并删掉，之后可以重新输入、不受限制：服务端每次下发 `lockedCells`（已锁上）与 `cellEditGrace`（窗口截止时刻），前端据此显示剩余秒数并到点自动变只读。**邀请未注册邮箱**：把视图分享给还没有账号的邮箱时，界面弹出确认框，确认后发一封邀请邮件（链接 `/invite/<token>`，7 天内有效），对方点开只填昵称 + 密码就完成注册并自动获得这条视图分享（不需要邮箱确认码）；服务端对未注册邮箱返回 `404 email_not_registered`，只有带 `invite: true` 才会真的发出邀请 |
| 附件 | 上传到 R2（默认上限 25MB，`MAX_UPLOAD_MB` 可调），元数据存 `files` 表 |
| 容量 | **按表格类型分**（口径见 `src/shared/tableKind.ts`）：**基础表格**最多 500 条记录（`MAX_DATABASE_RECORDS`）、附件合计最多 1GB（`MAX_DATABASE_STORAGE_MB`）、数据**保留 1 年**（`BASIC_TABLE_RETENTION_DAYS`，超期记录与附件由定时任务自动清除）；**专业表格**记录 / 附件 / 存储时间**都不限**。**只拦增长** —— 基础表格到上限后新建 / 批量新建 / 复制记录 / 上传附件一律 `403 capacity_exceeded`，而查看、查询、改已有记录、删记录（含公开链接页的编辑）照常；腾出空间后立刻又能新建。列数与视图数也按类型分：基础表格 10 列 / 3 个视图，专业表格 20 列 / 10 个视图（新增到上限后 `403 limit_exceeded`，删掉一些即可恢复；「＋」按钮同时置灰）。用量在侧边栏每张表后面以一个硬盘图标（💾）显示（专业表格恒为正常档位、明细里写「不限」）：记录 / 附件任一维度用掉 80% 起图标底色转浅黄、到上限转浅红，整表到上限再标「已满」；点一下弹出容量明细（两侧各自的已用 / 上限 / 剩余，基础表格另有「数据保留 1 年」提示）；表格页与公开链接页顶部另有提示条，新建按钮同时置灰 |
| 备注 | 记录卡片底部的备注**只增不改**（后端不提供修改 / 删除备注的接口，输入框旁也有提示）；输入 `@` 可提醒协作者——**表格所有者、表格成员、以及被定向分享视图的访客**彼此之间都能互相 @（公开链接的匿名访客没有身份，不在此列）；被 @ 的人会在左上角收件箱（灰色单色图标 + 红点数字）收到一条私信，点开即已读并跳到那条备注（高亮定位）；**跳转时会先把这条记录同步到最新再打开卡片**（走 `GET /api/records/:id`，只取一条记录，不受分页限制），卡片开着期间每 20 秒、以及切回标签页时再同步一次，所以别人刚加的备注 / 刚改的单元格不用刷新页面就能看到；@ 不到自己与表格外的人，单条备注最多 50 人 |

## 目录结构

```
src/
  shared/     前后端共享：types.ts(类型)、fields.ts(字段元数据/校验/格式化)、views.ts(视图配置)、templates.ts(表格模板，仅后端建表/示例数据使用；前端新建表格固定 blank)、capacity.ts(单表容量口径)、tableKind.ts(基础/专业表格的类型口径：容量 / 保留期 / 列数 / 视图数上限与对比文案)、quota.ts(表格名额：按类型分开算，默认为 0，每分享一次 +1，可购买)
  worker/     Worker 后端
    index.ts   入口：路由分发、错误处理、静态资源
    http.ts    json/readJson/参数校验/错误构造等工具
    auth.ts    Cookie 会话、密码哈希、requireUser
    admin.ts   超级管理员引导（ADMIN_EMAIL / ADMIN_PASSWORD）+ 用户列表查询 + 批量删除账号
    settings.ts 站点设置（站点名称 / 图标 / 管理员邮箱 / Resend 密钥与发件人）：读数据库 -> 环境变量 -> 默认值；图标存 R2
    routes/branding.ts 公开的站点品牌接口 /api/branding（+ /api/branding/icon）：标题 / favicon / 登录页用
    email.ts   Resend 发信（确认码 / 重置密码 / 视图邀请；没配 RESEND_API_KEY 或发信失败都只记日志，不阻断流程）
    emailCodes.ts 注册邮箱确认码：发码（15 分钟有效、60 秒重发节流）、校验、清过期
    invites.ts 视图分享邀请：签发 / 投递（邮件里 `/invite/<token>`）/ 接受后写入 view_shares
    access.ts  表格访问级别判定（view/edit/manage）
    changes.ts 多人协作的增量同步：改动日志（database_changes）+「自某个版本号起的改动」查询
    retention.ts 基础表格的保留期清理：超过一年（BASIC_TABLE_RETENTION_DAYS）的记录与附件（含 R2 对象）
    mappers.ts D1 行 -> API 类型
    routes/    auth / invites / admin / quota / databases / properties / records / views / public / files / notes / branding
  client/     React SPA
    App.tsx            会话 + 表格列表 + `/share/:token`、`/invite/:token` 路由
    api.ts             fetch 封装（cookie + `Authorization: Bearer` 兜底、ApiError、typed 响应）
    branding.ts        把站点名称 / 图标落到 `<title>` 与 favicon（`GET /api/branding`）
    components/        AuthPage Sidebar DatabasePage PublicPage TableGrid CardViews
                       Cell RecordDialog PropertyDialog ViewBar SharePanel Modal Popover
                       InboxButton UserChip FilterPanel ChangePasswordDialog
                       InvitePage AdminPanel SiteSettingsCard SiteMark ResetResultCard EditUserDialog
    lib/viewEngine.ts  前端筛选/排序/分组计算
    lib/time.ts        相对时间 / 精确时间的格式化
    lib/cellEditLocks.ts  单元格「限制编辑」的 10 秒计时窗口（判定 / 倒计时 / 到点自动只读）
    lib/session.ts     登录后的「会话落地」确认：Cookie 存不下来时回退到本地令牌 + Bearer
scripts/
  check-routes.mjs  路由静态检查（重复/处理器缺失/公开端点）
  smoke-test.mjs    端到端冒烟测试（失败时退出码 1）
tools/
  mobile-check/nocookie-login.mjs  本地诊断：用「丢掉 Set-Cookie」的反向代理模拟手机浏览器，验证登录后不会被打回登录页
  online-smoke-proxy.mjs           国内网络下让 Node 的 fetch 走系统代理，跑线上冒烟测试
migrations/
  0001_init.sql     D1 初始化迁移
  ...               0002-0005：视图定向分享 / 字段锁定 / 分享限制编辑等增量迁移
  0006_notes.sql    记录备注（notes）+ @提醒私信（note_mentions）
  0007_database_changes.sql  多人协作增量同步的改动日志（database_changes，rev 全局自增）
  0008_admin_and_email_codes.sql  超级管理员标记（users.is_admin）+ 注册邮箱确认码（email_codes）
  0009_view_invites.sql  视图分享邀请（view_invites）
  0010_site_settings.sql 站点设置键值表（settings：站点名称 / 图标 / 管理员邮箱 / Resend 密钥与发件人）
  0011_table_kinds_and_purchases.sql 表格类型（databases.kind：基础 / 专业）+ 名额购买流水（table_purchases）
```

## 快速开始

```bash
npm install

# 1. 本地 D1 建表（会写入 .wrangler/state，本地开发不需要真实 database_id）
npm run db:migrate:local

# 2.（可选）本地机密：Resend 发信密钥、超级管理员账号等。不配也能跑：
#    没配 RESEND_API_KEY 时确认码直接回显在接口响应里（devCode，仅测试域）
cp .dev.vars.example .dev.vars        # Windows PowerShell：Copy-Item .dev.vars.example .dev.vars

# 3. 构建前端 + 启动 Worker（http://127.0.0.1:8787）
npm run dev
```

- `npm run dev:web`：只跑 Vite 前端（`/api` 需代理到 Worker，见 `vite.config.ts`）
- `npm run typecheck`：`tsconfig.client.json` + `tsconfig.worker.json` 全量类型检查
- `npm run check:routes`：路由自检（当前 49 条路由）
- `npm run test:e2e`：对运行中的 Worker 跑端到端冒烟测试
- `.dev.vars`：本地机密（`RESEND_API_KEY`、`ADMIN_EMAIL` / `ADMIN_PASSWORD`），已在 `.gitignore` 里；
  模板见 `.dev.vars.example`，线上用 `npx wrangler secret put`（详见 [DEPLOY.md 6.6](./DEPLOY.md)）

```bash
# 端到端验证（另开一个终端，先 npm run dev）
node scripts/smoke-test.mjs
BASE_URL=https://cloudnotion.example.workers.dev node scripts/smoke-test.mjs
```

冒烟测试覆盖：健康检查 → **两步注册**（确认码 TTL / 测试域回显 / 60 秒重发节流 / 错误码 / 已用码不能重放 / 未确认邮箱不能登录）/ 会话 → 建表建字段 → 记录增删改查/批量/复制 → 视图增改删（含表级锁定参数被忽略的回归断言）→ 分享链接（只读拒写、可编辑可写、**限制编辑的 10 秒计时窗口**：窗口内同一格可以反复改（不限次数）、窗口内清空即视为没输入过（之后可重新输入）、窗口一过即拒写并列入 `lockedCells`）→ 成员邀请/改权/移除/所有者保护 → 备注 + @提醒私信（收件箱未读/已读、所有者 ↔ 定向分享访客互相 @、单条记录同步接口）→ **多人协作增量同步**（版本号游标、新行/改单元格/新备注/删行各自进增量、空增量、结构改动返回 reset）→ R2 上传下载 → **改密码**（当前密码必须正确、新旧不得相同、强度校验、其他设备被下线、当前设备保留、旧密码失效）→ **用户管理**（匿名 401 / 非管理员 403、按邮箱搜索、计数器与最近活跃、改昵称与邮箱、邮箱冲突 409、未知用户 404、重置他人密码 + 对方会话作废 + 临时密码可登录、重置自己后当前会话失效）→ **会话兜底（拿不到 Cookie 的手机浏览器）**（不下发令牌时不带 `session` / 登录响应里不该出现令牌、响应照旧带 `Set-Cookie`、`tokenInBody: true` 才给令牌、光靠 `Authorization: Bearer` 就能认证 `/api/session`、伪造令牌视为未登录、带令牌登出后令牌立即作废）→ **单表容量上限**（基础表格的记录数 / 附件到上限后只拦增长：新建 / 批量新建 / 复制 / 上传附件被 `403 capacity_exceeded` 挡下，编辑与删除已有记录照常，腾出空间后立刻恢复）→ **表格类型与名额**（新账号 0 个名额、购买基础 / 专业名额各按数量生效、名额用完建表 `403 quota_exceeded`、分享表格给同类型名额 +1、基础表格 10 列 / 3 视图与专业表格 20 列 / 10 视图到上限后 `403 limit_exceeded`、专业表格容量与保留期都不限）→ 清理。共 **259 项断言**（本地 / CI 的 e2e 用 `admin@example.com` 测试管理员，跑满 259；线上用真实 `ADMIN_EMAIL` 时自动跳过 2 项「重置自己密码」断言，跑 **257/257**；目标上压根没有该管理员账号时，整个「用户管理」段一并 `skip`，结果是 **236/236** 而不是失败）。

## 数据模型

- `users` / `sessions`：账号与会话（`sessions.token_hash` 唯一）；`users.is_admin = 1` = 超级管理员（由 `ADMIN_EMAIL` 引导写入），`sessions.last_seen_at` 供用户管理列表显示「最近活跃」
- `email_codes`：注册邮箱确认码（`email` + 6 位 `code_hash`、`expires_at`、`consumed_at`、`attempts`、`sent_at` = 60 秒重发节流）。
  只存哈希：确认过的码不能重放；验证通过前**不会**写 `users`，所以未确认的邮箱不占号
- `invites`：视图分享邀请（分享给**还没注册**的邮箱时写入：`token` 唯一、`email`、`database_id` + `view_id` + `role`/`limit_edits`、`expires_at`（默认 7 天）、`accepted_at`）。
  邮件里的链接 `/invite/<token>` 被打开后填昵称 + 密码即完成注册，并把这条视图分享写进 `view_shares`；没接受的邀请不占邮箱、也不出现在用户列表里
- `databases`：一张表格，`kind` = `basic`（基础表格）/ `pro`（专业表格）—— 容量、保留期、列数与视图数上限都按它取；`database_members`：受邀协作者（`role` = editor/viewer）
- `table_purchases`：表格名额购买流水（`user_id` + `kind` + `count`、`channel` 先记 `self-serve`），`/api/quota` 里「已购买」就是同类型 `count` 之和
- `properties`：字段定义（`type` + `config` JSON + `position` REAL 排序 + `is_locked` 字段级锁定）
- `records`：一行记录，`"values"` 字段存 `{ 字段id: 值 }` JSON 文本，`position` REAL 排序
  > 注意：`values` 是 SQLite 保留字，SQL 里必须写成 `"values"`（迁移与 `routes/*.ts` 均已加引号）
- `views`：视图（`type` + `config` JSON：filters/sorts/groupBy/visibleProperties/rowHeight/cardSize…）
- `shares`：公开分享链接（`token` 唯一、`permission`、`expires_at`）
- `files`：R2 对象元数据（`r2_key`、名称、大小、MIME）
- `cell_edits`：单元格级「限制编辑」的记账（`editor_key` = 公开链接 / 视图定向分享访问者的身份，`record_id` + `property_id` 定位格子，`created_at` = **最近一次**保存成功的时刻）。
  每保存一次就刷新 `created_at`（UPSERT），所以窗口始终从最近一次保存重新起算；把内容清空则直接删掉这条记账（= 没输入过，之后可以重新输入）。
  `created_at + 10 秒`（`CELL_EDIT_GRACE_MS`）之后只要这一格仍有内容就只读，接口据此下发 `lockedCells` / `cellEditGrace`
- `notes`：记录备注（评论），**只增不改**（没有 update / delete 语句与接口）
- `note_mentions`：备注里 @ 到的人 → 收件箱私信；`read_at` 为 NULL 表示未读（就是红点里的数字）
- `database_changes`：多人协作的**改动日志**（`rev` 全局自增主键、`kind` = row/delete/note/schema、`record_id`）。
  客户端带着看过的最大 `rev` 轮询增量接口；日志永远写在数据之后（先写数据、再写日志），
  所以「先读 rev 再读数据」不会漏改动，最多重复下发一次（客户端按 id 合并，幂等）。
  写入时以 1/20 的概率顺手清掉 7 天前的旧日志；日志被清过 / 攒了太多改动（> 500 条）时接口回
  `reset: true`，客户端整表重载一次

## API 一览

```
POST   /api/auth/register                 （发 6 位邮箱确认码 → 202 + codeTtl）
POST   /api/auth/register/verify          （校验确认码 → 建号并登录；带 tokenInBody: true 时响应里多一个 session）
POST   /api/auth/register/resend          （重发确认码，60 秒节流）
POST   /api/auth/login | /api/auth/logout （login 带 tokenInBody: true 时响应里多一个 session: { token, expiresAt }）
POST   /api/auth/password                 （登录后改密码：其他设备下线、当前设备保留）
GET    /api/session                       （需要登录的接口都同时认 cn_session cookie 与 Authorization: Bearer 头；响应里带 appName / siteIconUrl）
GET    /api/branding                      （公开：站点名称 / 图标地址，登录页、标题与 favicon 用）
GET    /api/branding/icon                 （公开：站点图标本体，带 ?v=<updated_at> 与长期缓存）
GET    /api/databases              POST /api/databases
GET|PATCH|DELETE /api/databases/:id
GET    /api/databases/:id/changes          （多人协作增量：自 ?since=<rev> 起的改动）
POST   /api/databases/:id/members
POST   /api/databases/:id/properties
GET|POST /api/databases/:id/records
POST   /api/databases/:id/records/bulk | /records/duplicate | /records/delete
GET    /api/databases/:id/rows            （按视图分页取行）
POST   /api/databases/:id/shares
POST   /api/databases/:id/views
PATCH|DELETE /api/views/:id
PATCH|DELETE /api/properties/:id
PATCH|DELETE /api/records/:id
GET    /api/records/:id                    （单条记录同步：值 + 备注 + 已用格子）
POST   /api/records/:id/notes              （备注只增不改：没有修改 / 删除接口）
GET    /api/inbox                          （未读私信列表 + 红点数字）
POST   /api/inbox/:id/read                 （点开一条私信 → 已读）
PATCH|DELETE /api/members/:id
DELETE /api/shares/:id
POST   /api/files   GET|DELETE /api/files/:id
GET    /api/public/:token
GET    /api/public/:token/changes          （公开链接页的增量同步，同一套逻辑）
POST   /api/public/:token/records
PATCH|DELETE /api/public/:token/records/:recordId
GET    /api/invites/:token                 （受邀人打开邀请链接：表格 / 视图 / 邀请人）
POST   /api/invites/:token/accept          （填昵称 + 密码完成注册，自动获得该视图分享；同样支持 tokenInBody）
POST   /api/databases/:id/view-shares      （邮箱未注册时 404 email_not_registered；带 invite: true 改为发邀请链接）
DELETE /api/view-shares/:id
GET    /api/admin/users                    （超级管理员：用户列表 ?search=&limit=&offset=）
PATCH  /api/admin/users/:id                （改昵称 / 邮箱，邮箱冲突 409）
POST   /api/admin/users/:id/password       （重置密码：邮件通知 + 作废对方会话）
POST   /api/admin/users/delete             （批量删除账号：连同其表格 / 上传文件一起清理）
GET    /api/admin/settings                 （「后台 → 站点设置」当前值；Resend 密钥只回传掩码）
PATCH  /api/admin/settings                 （保存站点名称 / 管理员邮箱 / 发件人 / Resend 密钥，返回最新 branding）
POST   /api/admin/settings/icon            （上传 / 替换站点图标，multipart 字段 `file`）
DELETE /api/admin/settings/icon            （移除站点图标）
GET    /api/health
```

## 部署

见 [DEPLOY.md](./DEPLOY.md)（创建 D1 / R2、替换 `wrangler.jsonc` 中的 `database_id`、远程迁移、`npm run deploy`）。

### 自动部署（GitHub Actions）

`.github/workflows/deploy.yml`：**push 到 `main` 自动部署**，PR 只做校验（不会部署）。

```
verify   npm ci -> npm run typecheck -> npm run check:routes -> vite build
e2e      本地 D1 迁移 -> 写临时 .dev.vars（测试管理员 + 回显白名单）-> wrangler dev --local -> scripts/smoke-test.mjs（242 项断言）
deploy   校验 D1 id -> 确保 R2 桶 -> 远程 D1 迁移 -> vite build -> wrangler deploy -> 同步可选 Secrets（邮件 / 管理员）-> 线上冒烟测试（本地那套 242 项断言；线上用真实 ADMIN_EMAIL 时自动跳过 2 项「重置自己密码」断言 → 240/240）
```

只需在仓库 `Settings → Secrets and variables → Actions` 配置：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | ✅ | API 令牌（Workers Scripts / D1 / R2 编辑权限） |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Cloudflare 账户 ID |
| `D1_DATABASE_ID` | ➖ | 可选，填了会自动替换 `wrangler.jsonc` 中的占位 `database_id` |
| `RESEND_API_KEY` | ➖ | Resend 发信密钥（注册确认码 / 重置密码通知）。不配时确认码直接回显为 `devCode`，只适合测试域 |
| `RESEND_FROM_EMAIL` | ➖ | 发件人，默认 `Varysheet <admin@varysheet.com>` |
| `ADMIN_EMAIL` | ➖ | 超级管理员邮箱：首次登录（或 `GET /api/session`）自动创建 / 提升该账号；默认 `admin@varysheet.com` |
| `ADMIN_PASSWORD` | ➖ | 管理员首次创建时用的密码（8 位以上、含字母与数字）；配上 `ADMIN_RESET_PASSWORD=true` 还能覆盖已有密码 |

> 站点名称 / 图标 / 管理员邮箱 / Resend 密钥与发件人也可以在**后台 → 站点设置**里改，保存在 D1 的 `settings` 表里，
> 优先级高于上面这些 Secret（`wrangler.jsonc` 的 `vars.APP_NAME` 同理）。所以升级后不必重配任何 Secret：
> 数据库里没值时按「环境变量 / secret → 代码默认值」依次兜底。

后面 4 个「可选」Secret 会在部署成功后由工作流用 `wrangler secret put` 写入 Worker（未配置就跳过）；本地开发把它们放进 `.dev.vars`（模板 `.dev.vars.example`）。完整说明见 [DEPLOY.md 6.6](./DEPLOY.md)。

未配置 `CLOUDFLARE_*` 时会安全跳过部署并给出 warning；详细步骤与权限清单见 [DEPLOY.md 第 6 节](./DEPLOY.md)。
