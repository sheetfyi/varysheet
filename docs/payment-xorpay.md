# 用 XorPay 接入「表格名额」购买（完整方案）

> 目标：把现在「点购买 → 直接写流水、立刻加名额」的自助直通，换成
> **下单 → 扫码/跳转支付 → 支付平台回调确认 → 加名额** 的真实收款链路。
> 支付通道用 [XorPay](https://xorpay.com)（微信支付服务商 + 支付宝 ISV，支持个人 / 个体户 / 企业）。
> 本文是**落地指导**：每一节都给出要改的文件、可直接照抄的代码、验证命令与上线步骤。
>
> 官方文档（本方案依据的字段名与规则）：<https://xorpay.com/doc/> ——
> `api.html`（API 接口）/ `sign.html`（签名算法）/ `native.html`（微信 NATIVE 扫码）/
> `alipay.html`（支付宝当面付）/ `notify.html`（回调通知）/ `query.html`（订单状态查询）/
> `qr.html`（二维码图片）/ `faq.html`（资质与费率）/ `risk.html`（风控）。
>
> **最终落地的实现（与本文初版方案的两点差异，已生效）**
>   1. 收款配置放在**「后台 → 站点设置」**里填（存 D1 的 `settings` 表，保存即生效、不用重新部署）；
>      环境变量 `XORPAY_AID` / `XORPAY_APP_SECRET` 仍然可用，作为本地开发 / CI 的兜底。
>      两者合并的判定见 `src/worker/xorpay.ts` 的 `xorpayConfigOf()`。
>   2. **默认只开微信扫码**（`native`）：`DEFAULT_XORPAY_PAY_TYPES = ['native']`。
>      支付宝当面付的代码路径已经就绪 —— XorPay 那边开通支付宝后，用 `XORPAY_PAY_TYPES=alipay`
>      （或 `native,alipay`）打开即可，不用改代码。
>   3. 另外新增了一个管理员赠额接口 `POST /api/admin/quota/grants`
>      （客服补偿 / 活动赠送 / 线上冒烟测试发名额用），见 §6.6 与 §8.2。
>
> 因此下文 §4 里「`wrangler secret put` 配 aid / secret」是**可选兜底**，常规做法是在后台填；
> §9 的上线步骤同理（第 6 / 7 步可简化为「在后台填一下并保存」）。

---

## 0. 结论速览

| 项目 | 现状（本仓库） | 接入 XorPay 后 |
| --- | --- | --- |
| 购买接口 | `POST /api/quota/purchases`：服务端算价 + 立刻写 `table_purchases` | 拆成「下单 → 支付 → 回调交付」三步 |
| 支付凭证 | 没有（`channel = 'self-serve'`） | `table_orders` 订单 + `table_purchases.order_id`，渠道写 `xorpay:native` / `xorpay:alipay` |
| 名额生效时机 | 点按钮立刻生效 | **回调验签通过 + 金额核对通过**之后才生效 |
| 前端 | 点「购买」→ 关弹窗 | 点「去支付」→ 弹二维码（微信扫码 / 支付宝扫码、手机可拉起 App）→ 每 3 秒轮询订单 → 到账后自动刷新名额 |
| 关键坑 | — | ① 回调地址必须**公网可达**（`*.workers.dev` 在国内不稳，建议绑自定义域）；② 支付宝当面付个人单笔限额 ¥1000、微信单笔 ¥20000，而本仓库单笔最高可达 ¥59,940（专业 99.9 元/月 × 10 个 × 60 个月）→ **必须加单笔上限校验**；③ Workers 的 Web Crypto 没有 MD5，要自带实现 |

需要改动的文件（全部清单）：

```
migrations/control/0016_table_orders.sql        新增：订单表 + table_purchases.order_id
src/worker/md5.ts                               新增：纯 TS MD5（XorPay 签名用）
src/worker/xorpay.ts                            新增：下单 / 查询 / 验签 / 配置判定
src/worker/routes/payments.ts                   新增：下单、查单、回调三个接口
src/worker/routes/admin.ts                      新增：管理员赠额（给冒烟测试与客服补偿用）
src/worker/routes/quota.ts                      改：purchaseHandler 走「下单」，抽公共校验
src/worker/types.ts                            改：Env 增加 XORPAY_* 字段
src/worker/index.ts                            改：注册 paymentsRoutes
src/shared/types.ts                            改：TableOrder 类型 + 订单状态口径
src/shared/xorpay.ts                           新增：客户端/服务端共用的支付方式与限额口径
src/client/api.ts                              改：createQuotaOrder / quotaOrder
src/client/components/Sidebar.tsx              改：QuotaDialog 增加「支付方式」与二维码区
src/client/App.tsx                             改：buyQuota → 下单 / 轮询 / 刷新
scripts/smoke-test.mjs                         改：购买段走订单接口（未配支付时仍是「立即到账」）
.github/workflows/deploy.yml                   改：同步 XORPAY_AID / XORPAY_APP_SECRET 两个可选 Secret
wrangler.jsonc / .dev.vars.example             改：说明这两个变量（值放 secret / .dev.vars）
README.md / DEPLOY.md / docs/storage.md        改：文案与运维说明
```

---

## 1. XorPay 是什么：资质、费用、渠道怎么选

**资质**（`faq.html` 原文）

- 支持**个人、个体户、企业、其他组织**接入；个人可开户，但**有额度限制**，个体户 / 公司不限额。
- 开通时交 **¥100 开通费**（防恶意提交资料，开通后不退）。微信或支付宝**任一渠道**进件成功即视为开通。
- 资料进件后：微信几分钟、支付宝几小时审核；微信会打一个机器人电话测手机连通性（按 1 即可）。
- 资金**不经 XorPay 中转**：微信 T+1 结算到本人同名银行卡，支付宝即时到账。

**费用**（`faq.html` 原文）

| 部分 | 金额 |
| --- | --- |
| 渠道手续费（微信 / 支付宝官方） | **0.38%**，每笔从收款里扣 |
| XorPay 平台手续费 | 体验版 1.2% / 基础版 1% / 标准版 0.8% / 高级版 0.6%，交易成功后从 XorPay 余额扣（需先充值） |
| XorPay 平台套餐费 | ¥0 / ¥10 / ¥30 / ¥60 每月 |

**限额**（`faq.html` 原文，直接影响本仓库的定价组合）

- 微信：单笔 **¥20,000**，单日 ¥50,000。
- 支付宝（个人当面付）：单笔 **¥1,000**，单日 ¥50,000。
- 本仓库最高单笔金额 = 专业表格 ¥99.9/月 × 最多 10 个名额 × 最长 60 个月 = **¥59,940**，
  微信超单笔限额、支付宝更是远超 → 见 §2 的「单笔上限」决策。

**渠道怎么选**（`product.html` 原文，PC 网站场景）

| 场景 | 推荐接口 | XorPay `pay_type` | 我们怎么用 |
| --- | --- | --- | --- |
| PC 网页：展示二维码，用户手机扫码 | 微信 NATIVE | `native` | 主推：返回 `info.qr`（`weixin://wxpay/bizpayurl?...`） |
| PC 网页 / 手机：支付宝扫码，或手机点链接拉起支付宝 App | 支付宝当面付 | `alipay` | 备选：返回 `info.qr`（`https://qr.alipay.com/...`，带 App 的浏览器可直接跳转拉起） |
| 微信内置浏览器里直接拉起微信支付 | 收银台 / JSAPI | `jsapi` | **本期不做**（要处理 openid 回跳，先不上） |

> 结论：本期只做 **`native`（微信扫码）+ `alipay`（支付宝当面付）** 两条通道 —— 两者都是
> 「服务端下单拿二维码 → 前端画二维码 → 回调到账」，一条代码路径就能覆盖 PC 与手机浏览器；
> 支付宝的 `qr` 链接在手机浏览器里还能直接拉起支付宝 App（H5）。
> 二维码图片不用引第三方库：XorPay 自带 `GET https://xorpay.com/qr?data=<内容>`，返回一张图片，
> 直接当 `<img src>` 用（`qr.html`）。

---

## 2. 架构与 5 个必须先定的决策

### 2.1 下单接口（XorPay 原文）

| 项 | 值 |
| --- | --- |
| 地址 | `POST https://xorpay.com/api/pay/{aid}`（`aid` = 你后台的 appid） |
| 编码 | `content-type: application/x-www-form-urlencoded` |
| 参数 | `name`（商品名）、`pay_type`（`native` / `alipay`）、`price`（字符串，如 `"50.00"`）、`order_id`（**你平台订单号，需唯一**）、`order_uid`（可选，我们传用户邮箱）、`notify_url`（**必填**，回调地址）、`more`（可选，回调原样回传）、`expire`（可选，默认 7200 秒）、`sign` |
| 签名 | `md5(name + pay_type + price + order_id + notify_url + app_secret)` —— **纯 value 顺序拼接、无分隔符、无 `+` 号**，小写 |
| 成功返回 | `{"status":"ok","aoid":"<XorPay 平台订单号>","expire_in":7200,"info":{"qr":"weixin://wxpay/bizpayurl?pr=xxx"}}` |
| 失败 | `status` ∈ `missing_argument` / `app_off` / `aid_not_exist` / `pay_type_error` / `sign_error` / `order_payed` / `order_expire` / `wechat_api_error` / `alipay_api_error` / `fee_error` / `order_exist` |

### 2.2 回调通知（XorPay 原文）

| 项 | 值 |
| --- | --- |
| 发送到 | 你下单时传的 `notify_url`，`POST` + `application/x-www-form-urlencoded` |
| 参数 | `aoid`、`order_id`、`pay_price`（如 `50.00`）、`pay_time`（`2019-01-01 00:00:00`）、`more`、`detail`（JSON：`transaction_id` 渠道流水号 / `bank_type` 付款方式 / `buyer`）、`sign` |
| 验签 | `md5(aoid + order_id + pay_price + pay_time + app_secret)`，顺序固定 |
| 响应 | 回 **HTTP 200**（内容 `ok` / `success` 都行）才算通知成功；否则按 `1/2/4/16/64/300` 分钟重试 **6 次** |

### 2.3 订单查询（兜底，回调丢了也能补）

- `GET https://xorpay.com/api/query/{aoid}` —— 用平台订单号查，**无需签名**。
- `GET https://xorpay.com/api/query2/{aid}?order_id=xxx&sign=xxx` —— 用**你自己的订单号**查，
  `sign = md5(order_id + app_secret)`。
- 返回 `status` ∈ `not_exist` / `new`（未支付）/ `payed`（已支付、还没通知成功）/
  `fee_error`（手续费扣除失败）/ `success`（已支付且通知成功）/ `expire`。

> 我们的「查单接口」用 `query2`（按自己的 `order_id` 查，落库最关键的那个 id），
> 前端每次轮询都顺带打一次 XorPay —— 回调因为网络原因丢了时，用户一刷新就能自己补上名额。

### 2.4 五个必须先定的决策

**决策 1：金额与名额只在服务端算，客户端传什么都不作数**
沿用现有做法（`purchaseAmountCents()`），下单时把 `amountCents` 冻进订单行；回调时再核对
`pay_price`（元 → 分）与订单金额**完全相等**，不等不交付。

**决策 2：单笔金额上限（限额是硬约束）**
支付宝当面付个人单笔 ¥1,000、微信 ¥20,000，而本仓库最高组合是 ¥59,940。方案：

- `src/shared/xorpay.ts` 里定义 `MAX_ORDER_AMOUNT_CENTS = 100_000`（¥1000，取最严的那个渠道限额）
  与 `orderAmountHint()`（完整代码见 §5）；
- 服务端在**下单前**就把超限的订单挡成 `400 order_amount_too_large`；
- 前端在下单按钮旁直接显示 `orderAmountHint(...)`，不要把用户送到支付页再失败。

若以后只卖小额，可把上限调到微信的 ¥20,000。

**决策 3：名额什么时候生效 —— 回调/查单确认后才生效，且严格幂等**
用一张订单表 + 一个「状态守卫」：

```sql
-- 只有把 pending 改成 paid 的那一次更新（changes = 1）才继续交付名额；
-- 重复回调、并发回调、重试 6 次都只会交付一次。
UPDATE table_orders SET status = 'paid', paid_at = ? WHERE id = ? AND status <> 'paid';
```

**决策 4：没有配 XorPay 时怎么办（本地开发 / CI / 还没拿到资质）**
`XORPAY_AID` + `XORPAY_APP_SECRET` 没配 → 沿用现在的**自助直通**（下单即交付、`channel = 'self-serve'`）。
这样 `scripts/smoke-test.mjs` 的 288 项断言、本地开发、以及「资质还在审核」的阶段都不受影响；
一旦两个 secret 配好，同一条下单接口自动变成「返回二维码、等支付」。

**决策 5：线上冒烟测试怎么建表（支付一旦开启，就没有免费名额了）**
冒烟测试用的是临时注册的 `smoke+...@example.com`，以前靠 `/api/quota/purchases` 白拿名额。
接入支付后线上不能白拿 → **给管理员加一个赠额接口**（也正好是客服补偿 / 活动赠送需要的功能）：

```
POST /api/admin/quota/grants   { email, kind, count, months, note }
→ 写一条 table_purchases（channel = 'admin-grant'，created_by = 管理员）
```

`scripts/smoke-test.mjs` 改成：能直通就直通（未配支付），否则用管理员账号调赠额接口给测试账号发名额。

---

## 3. 数据模型：迁移 `migrations/control/0016_table_orders.sql`

新建文件 `migrations/control/0016_table_orders.sql`：

```sql
-- Varysheet - 表格名额的支付订单（D1 / SQLite）
-- Applied with:  npx wrangler d1 migrations apply cloudnotion-db --local|--remote
--
-- 接入 XorPay 之后，购买分三步走（见 docs/payment-xorpay.md）：
--   1) 下单：算价（服务端）→ 写一行 status = 'pending' 的订单 → 调 XorPay 拿支付二维码；
--   2) 支付：用户扫码付款（微信 NATIVE / 支付宝当面付）；
--   3) 交付：XorPay 回调（或前端查单兜底）验签通过、金额核对通过后，
--      把订单改成 'paid' 并写一条 table_purchases（名额从这里来），channel 记
--      'xorpay:native' / 'xorpay:alipay'；没配支付时的自助直通仍是 'self-serve'。
--
-- id 就是我们自己的订单号，同时也是传给 XorPay 的 order_id（XorPay 要求平台侧唯一）；
-- aoid 是 XorPay 的平台订单号（回调 / 主动查询都用得上）。幂等靠
--   UPDATE table_orders SET status='paid' WHERE id=? AND status<>'paid'
-- 的 changes 数判断（见 src/worker/routes/payments.ts 的 deliverOrder）。

CREATE TABLE IF NOT EXISTS table_orders (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'basic',   -- basic（基础表格）| pro（专业表格）
  count            INTEGER NOT NULL DEFAULT 1,      -- 这一单买几个名额
  months           INTEGER NOT NULL DEFAULT 1,      -- 总时长（月），口径同 table_purchases.months
  amount_cents     INTEGER NOT NULL DEFAULT 0,      -- 应付金额（分），服务端算好后冻结在这一行
  paid_cents       INTEGER NOT NULL DEFAULT 0,      -- 回调里的实收金额（分），用于对账
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | paid | expired | canceled | amount_mismatch
  pay_type         TEXT NOT NULL DEFAULT '',        -- native（微信扫码）| alipay（支付宝当面付）| ''（自助直通）
  channel          TEXT NOT NULL DEFAULT '',        -- xorpay | self-serve（交付时写进 table_purchases.channel）
  aoid             TEXT NOT NULL DEFAULT '',        -- XorPay 平台订单号
  qr               TEXT NOT NULL DEFAULT '',        -- 支付二维码内容（前端用 xorpay.com/qr?data= 画图）
  transaction_id   TEXT NOT NULL DEFAULT '',        -- 渠道流水号（回调 detail.transaction_id）
  buyer            TEXT NOT NULL DEFAULT '',        -- 付款方（回调 detail.buyer，对账用）
  notify_raw       TEXT NOT NULL DEFAULT '',        -- 最近一次回调原文（排障 / 对账，截断保存）
  purchase_id      TEXT NOT NULL DEFAULT '',        -- 交付后写入的 table_purchases.id（自愈用）
  expires_at       INTEGER NOT NULL DEFAULT 0,      -- 订单过期时刻（毫秒）
  paid_at          INTEGER,                         -- 支付确认时刻（毫秒）
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_table_orders_user ON table_orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_table_orders_status ON table_orders(status, created_at);

-- 一条流水对应一张订单（幂等 + 对账）：只有订单交付时才写 purchase，且只写一次。
ALTER TABLE table_purchases ADD COLUMN order_id TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_table_purchases_order
  ON table_purchases(order_id) WHERE order_id <> '';
```

要点：

- `aoid` 不建唯一索引 —— 自助直通（没有 `aoid`）会写出大量空串；要唯一就只能是**部分唯一索引**
  （`WHERE aoid <> ''`），但**同一个 XorPay 订单号只能对应一行**这件事由 `order_id` 侧保证（见下）。
- `table_purchases.order_id` 的部分唯一索引是**第二道闸**：即使状态守卫出现意外，
  重复交付也只会在 `INSERT` 时撞唯一索引（用 `INSERT OR IGNORE` 处理）。
- 老数据不受影响：`order_id` 默认空串，索引是 `WHERE order_id <> ''`，旧流水不会互相撞。

> ⚠️ 迁移要**先本地跑通**再上线上：`npm run db:migrate:local`，然后 `npm run db:migrate:remote`
> （CI 的部署步骤会自动 apply，见 `.github/workflows/deploy.yml`）。

---

## 4. 环境变量、Secret 与回调地址

| 变量 | 放哪 | 说明 |
| --- | --- | --- |
| `XORPAY_AID` | Worker secret（线上）/ `.dev.vars`（本地） | XorPay 后台的 appid。**两个都配齐才算开启支付** |
| `XORPAY_APP_SECRET` | 同上 | XorPay 后台的 app secret，签名与验签用它 |
| `XORPAY_API_BASE` | 可选，本地调试用 | 默认 `https://xorpay.com`；本地指向假服务器（见 §8） |
| `XORPAY_PAY_TYPES` | 可选 | 逗号分隔，默认 `native,alipay`；线上想临时只留一个通道时改这里 |
| `PUBLIC_BASE_URL` | 可选但**强烈建议** | 生成 `notify_url` 用，例如 `https://varysheet.com`；不配就从请求头推 |

本地 `.dev.vars`（`.dev.vars.example` 里也加一份注释模板，**不要写真实值**）：

```ini
# ---- XorPay 收款（https://xorpay.com；未配置这两项时购买走「自助直通」，不产生真实收款）----
# 后台「应用配置」里的 appid 与 app secret
XORPAY_AID=
XORPAY_APP_SECRET=
# 可选：本地调假 XorPay 服务器（scripts/fake-xorpay.mjs，见 docs/payment-xorpay.md §8）
# XORPAY_API_BASE=http://127.0.0.1:8788
```

线上写 secret（或配同名的 GitHub Secrets，CI 会自动同步 —— 见 §9）：

```bash
npx wrangler secret put XORPAY_AID
npx wrangler secret put XORPAY_APP_SECRET
```

**回调地址（`notify_url`）怎么算**

```ts
// src/worker/xorpay.ts
export function notifyUrlOf(env: Env, request: Request): string {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || new URL(request.url).origin;
  return `${base}/api/xorpay/notify`;
}
```

关键约束（必须提前解决，否则「付了钱不到账」）：

1. **回调是 XorPay 的服务器（国内）打给你的 Worker**，必须公网可达。
   `*.workers.dev` 在国内访问经常失败 → **务必绑定一个自定义域名**（`wrangler.jsonc` 的
   `routes` / 控制台 Domains & Routes），并把 `PUBLIC_BASE_URL` 设成它。
2. 自定义域名建议**已备案**：微信支付 / 支付宝签约时会校验跳转域名，未备案域名容易被拒；
   备案主体与签约主体一致最稳。
3. `notify_url` **不要带查询串或临时 token**（XorPay 原样 POST），签名才是唯一凭据。
4. 回调地址一旦在生产用过就别频繁改 —— 老订单的补发通知（6 次重试）会打到旧地址。

---

## 5. 共享口径：`src/shared/xorpay.ts`（新建）

前端与服务端都要用的东西放这里（支付方式、限额、订单状态文案），和 `shared/quota.ts` /
`shared/tableKind.ts` 一个套路 —— 文案与口径只写一次：

```ts
/**
 * XorPay 收款的口径：支付方式、单笔限额与订单状态文案（前端 / Worker 共用）。
 *
 * 字段名与签名规则来自官方文档 https://xorpay.com/doc/ （api.html / sign.html / notify.html）：
 *   下单   POST /api/pay/{aid}          sign = md5(name + pay_type + price + order_id + notify_url + app_secret)
 *   回调   POST 到你传的 notify_url      sign = md5(aoid + order_id + pay_price + pay_time + app_secret)
 *   查单   GET  /api/query2/{aid}?order_id=&sign=      sign = md5(order_id + app_secret)
 * 都是「纯 value 顺序拼接 + app secret，MD5 后小写」。
 */
import { formatPriceCents } from './tableKind';

/** 本仓库支持的支付方式：微信 NATIVE 扫码 / 支付宝当面付（都是「服务端下单拿二维码」） */
export const XORPAY_PAY_TYPES = ['native', 'alipay'] as const;
export type XorpayPayType = (typeof XORPAY_PAY_TYPES)[number];

/** 默认两条通道都开（可用环境变量 XORPAY_PAY_TYPES 收窄） */
export const DEFAULT_XORPAY_PAY_TYPES: readonly XorpayPayType[] = XORPAY_PAY_TYPES;

/** 任何来路不明的值都当「微信扫码」（老客户端 / 脏数据都不会掉进未知通道） */
export function asXorpayPayType(value: unknown): XorpayPayType {
  return value === 'alipay' ? 'alipay' : 'native';
}

/** 「微信」「支付宝」——购买区与订单状态文案用它 */
export function xorpayPayTypeLabel(payType: XorpayPayType | string | null | undefined): string {
  return asXorpayPayType(payType) === 'alipay' ? '支付宝' : '微信';
}

/**
 * 单笔订单金额上限（分）= ¥1000。
 * 取「支付宝当面付个人单笔限额 ¥1000」这个最小的渠道限额当统一上限：
 * 微信单笔能到 ¥20000，但两条通道共用一个上限最省事，也不会出现「微信能付、支付宝付不了」。
 * 本仓库最高组合是 ¥59,940（专业 ¥99.9/月 × 10 个 × 60 个月），必须拆单。
 */
export const MAX_ORDER_AMOUNT_CENTS = 100_000;

/** 订单有效期（分钟）：与下单接口传的 expire 保持一致（XorPay 默认 7200 秒） */
export const ORDER_TTL_MINUTES = 120;

/** 订单状态：pending 待到账 / paid 已交付 / expired 已过期 / canceled 已取消 / amount_mismatch 金额不符（待人工） */
export type TableOrderStatus = 'pending' | 'paid' | 'expired' | 'canceled' | 'amount_mismatch';

/** 订单状态文案（购买弹窗与「我的订单」提示都用它） */
export function orderStatusText(status: TableOrderStatus | string): string {
  switch (status) {
    case 'paid':
      return '已支付，名额已到账';
    case 'expired':
      return '已过期（超时未支付），重新下单即可';
    case 'canceled':
      return '已取消';
    case 'amount_mismatch':
      return '实付金额与订单不一致，请联系客服人工处理';
    default:
      return '等待支付';
  }
}

/** 金额超上限时给用户的一句话（不超限返回空串） */
export function orderAmountHint(amountCents: number, payType: XorpayPayType | string): string {
  if (!Number.isFinite(amountCents) || amountCents <= MAX_ORDER_AMOUNT_CENTS) return '';
  return `单笔最多 ${formatPriceCents(MAX_ORDER_AMOUNT_CENTS)}（${xorpayPayTypeLabel(payType)}扫码单笔限额），请减少数量或时长，分多笔购买`;
}

/** 二维码图片地址：XorPay 自带生成接口（GET https://xorpay.com/qr?data=内容 → 返回图片） */
export const XORPAY_QR_IMAGE_BASE = 'https://xorpay.com/qr';

/** 把支付二维码内容包成可直接放进 <img src> 的地址 */
export function xorpayQrImageUrl(qr: string): string {
  return `${XORPAY_QR_IMAGE_BASE}?data=${encodeURIComponent(qr)}`;
}

/** 手机浏览器里点「用支付宝打开」时的深链（支付宝当面付只有这条通道能拉起 App） */
export function xorpayAlipayDeepLink(qr: string): string {
  return `alipays://platformapi/startapp?appId=20000067&url=${encodeURIComponent(qr)}`;
}
```

`src/shared/types.ts` 里补一条订单类型（`TablePurchase` 旁边）：

```ts
/**
 * 一张支付订单（`table_orders` 表）。
 * 下单时冻结金额与名额参数，支付确认（XorPay 回调 / 主动查单）后才写 `table_purchases` 并加名额。
 * 未配置 XorPay 时是「自助直通」：下单即 `status = 'paid'`（`payType` 空串、`channel = 'self-serve'`）。
 */
export interface TableOrder {
  id: string;
  userId: string;
  kind: TableKind;
  count: number;
  months: number;
  /** 应付金额（分），服务端算好冻结 */
  amountCents: number;
  /** 实收金额（分），回调对账用 */
  paidCents: number;
  status: TableOrderStatus;
  /** native（微信扫码）/ alipay（支付宝当面付）/ ''（自助直通） */
  payType: XorpayPayType | '';
  /** xorpay | self-serve */
  channel: string;
  /** XorPay 平台订单号 */
  aoid: string;
  /** 支付二维码内容（前端用 `xorpayQrImageUrl()` 画图） */
  qr: string;
  expiresAt: number;
  paidAt: number | null;
  createdAt: number;
}
```

`shared/types.ts` 顶部记得补上类型导入（`shared/xorpay.ts` 只依赖 `tableKind.ts`，和 `types.ts`
之间没有循环依赖）：

```ts
import type { TableOrderStatus, XorpayPayType } from './xorpay';
```

---

## 6. 服务端实现

### 6.1 `src/worker/md5.ts`（新建，纯 TS，已用 RFC 1321 官方向量验证）

> Workers 的 Web Crypto（`crypto.subtle`）**不提供 MD5**，而 XorPay 的签名只认 MD5。
> 这里自带一个不依赖运行时的实现（Node 里也能跑，便于本地联调脚本复用）：
> 标准向量 `md5("")`、`md5("abc")`、`md5("message digest")`、26 字母、80 位数字串全通过，
> 并与 `node:crypto` 的 `createHash('md5')` 对 300 条随机 UTF-8 字符串逐条一致。

```ts
/**
 * 纯 TypeScript 的 MD5（RFC 1321），给 XorPay 的签名 / 验签用。
 *
 * 为什么不用现成的：Workers 的 Web Crypto 没有 MD5（只有 SHA 系列），
 * 而 XorPay 的下单、回调、查单三个签名都是 `md5(value 顺序拼接 + app secret)`。
 * 实现只做一件事：UTF-8 字符串 → 32 位小写十六进制摘要。
 */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  // 填充：先补一个 0x80，再补 0 到「长度 % 64 === 56」，最后 8 字节小端位长
  const withOne = bytes.length + 1;
  const padLength = (56 - (withOne % 64) + 64) % 64;
  const total = withOne + padLength + 8;
  const buffer = new Uint8Array(total);
  buffer.set(bytes, 0);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(total - 8, bitLength >>> 0, true);
  view.setUint32(total - 4, Math.floor(bitLength / 0x100000000), true);

  /** 每轮的左移位数（RFC 1321 表 T） */
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  /** K[i] = floor(abs(sin(i + 1)) * 2^32) */
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i += 1) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  const chunk = new Uint32Array(16);

  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) chunk[i] = view.getUint32(offset + i * 4, true);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const previousD = d;
      d = c;
      c = b;
      const sum = (a + f + table[i] + chunk[g]) | 0;
      b = (b + ((sum << shifts[i]) | (sum >>> (32 - shifts[i])))) | 0;
      a = previousD;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
  }

  let out = '';
  for (const word of [h0, h1, h2, h3]) {
    // 小端序输出
    for (let i = 0; i < 4; i += 1) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}
```

### 6.2 `src/worker/xorpay.ts`（新建：配置判定 + 签名 + 下单 + 查单）

```ts
/**
 * XorPay 支付网关封装（https://xorpay.com）——只做「下单 / 查单 / 签名」，不碰数据库。
 *
 * 官方文档：https://xorpay.com/doc/
 *   api.html / sign.html / native.html / alipay.html / notify.html / query.html
 *
 * 签名规则：把文档列出的参数**按顺序拼 value**（不带 key、不带分隔符、不加 `+`），
 * 末尾接上 app secret，整体 MD5 取小写。三个签名分别是：
 *   下单  md5(name + pay_type + price + order_id + notify_url + app_secret)
 *   回调  md5(aoid + order_id + pay_price + pay_time + app_secret)
 *   查单  md5(order_id + app_secret)
 */
import { DEFAULT_XORPAY_PAY_TYPES, asXorpayPayType, type XorpayPayType } from '../shared/xorpay';
import { badGateway } from './http';
import { md5Hex } from './md5';
import type { Env } from './types';

/** 下单时传给 XorPay 的过期秒数：120 分钟（与 shared/xorpay.ts 的 ORDER_TTL_MINUTES 一致） */
export const ORDER_TTL_SECONDS = 7200;

/** 接口基址：本地联调可以指向假服务器（XORPAY_API_BASE） */
export function xorpayApiBase(env: Env): string {
  return (env.XORPAY_API_BASE?.trim() || 'https://xorpay.com').replace(/\/+$/, '');
}

/** 两个 secret 都配齐才算开启真实收款；否则购买走「自助直通」（本地开发 / CI / 资质审核期） */
export function xorpayConfigured(env: Env): boolean {
  return Boolean(env.XORPAY_AID?.trim() && env.XORPAY_APP_SECRET?.trim());
}

/** 开放的支付方式：默认 native + alipay，可用 XORPAY_PAY_TYPES 收窄（非法值一律忽略） */
export function enabledPayTypes(env: Env): XorpayPayType[] {
  const raw = env.XORPAY_PAY_TYPES?.trim();
  if (!raw) return [...DEFAULT_XORPAY_PAY_TYPES];
  const wanted = raw.split(',').map((item) => item.trim().toLowerCase());
  const allowed = DEFAULT_XORPAY_PAY_TYPES.filter((item) => wanted.includes(item));
  return allowed.length ? allowed : [...DEFAULT_XORPAY_PAY_TYPES];
}

function appSecretOf(env: Env): string {
  return env.XORPAY_APP_SECRET?.trim() ?? '';
}

function aidOf(env: Env): string {
  return env.XORPAY_AID?.trim() ?? '';
}

/**
 * 回调地址：优先用 PUBLIC_BASE_URL（线上必须配成自定义域名 —— 详见 docs/payment-xorpay.md §4），
 * 没配就退回当前请求的 origin。这个地址会写进 XorPay 的订单，必须公网可达。
 */
export function notifyUrlOf(env: Env, request: Request): string {
  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || new URL(request.url).origin;
  return `${base}/api/xorpay/notify`;
}

/** 分 → XorPay 要的「元」字符串：`1990` → `19.90` */
export function priceTextOf(amountCents: number): string {
  return (amountCents / 100).toFixed(2);
}

/** 「元」字符串 → 分：`"19.90"` → 1990；非法 / 负数返回 null */
export function priceCentsOf(text: unknown): number | null {
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** 下单签名（详见文件头注释） */
export function createOrderSign(
  env: Env,
  input: { payType: XorpayPayType | string; name: string; price: string; orderId: string; notifyUrl: string },
): string {
  const { payType, name, price, orderId, notifyUrl } = input;
  return md5Hex(`${name}${asXorpayPayType(payType)}${price}${orderId}${notifyUrl}${appSecretOf(env)}`);
}

/** 回调验签：aoid + order_id + pay_price + pay_time + app_secret */
export function notifySignOf(
  env: Env,
  input: { aoid: string; orderId: string; payPrice: string; payTime: string },
): string {
  const { aoid, orderId, payPrice, payTime } = input;
  return md5Hex(`${aoid}${orderId}${payPrice}${payTime}${appSecretOf(env)}`);
}

/** 查单签名：order_id + app_secret */
export function querySignOf(env: Env, orderId: string): string {
  return md5Hex(`${orderId}${appSecretOf(env)}`);
}

/** XorPay 的错误码 → 中文提示（排障与前端提示共用） */
const XORPAY_ERROR_TEXT: Record<string, string> = {
  missing_argument: '下单参数不完整',
  app_off: 'XorPay 账号被冻结',
  aid_not_exist: 'XorPay 的 aid 不存在（检查 XORPAY_AID）',
  pay_type_error: '支付方式不支持（检查 XORPAY_PAY_TYPES）',
  sign_error: '签名错误（检查 XORPAY_APP_SECRET）',
  order_payed: '该订单已经支付过了',
  order_expire: '订单已过期，请重新下单',
  order_exist: '同一订单号提交了不同参数，请重新下单',
  wechat_api_error: '微信侧异常（可能账号被风控）',
  alipay_api_error: '支付宝侧异常（可能未完成签约或被风控）',
  no_contract: 'XorPay 账号尚未签约',
  no_alipay_contract: '支付宝尚未签约',
  fee_error: 'XorPay 账号余额不足（手续费扣款失败）',
  not_exist: '订单不存在',
};

export function xorpayErrorText(status: string, info = ''): string {
  const text = XORPAY_ERROR_TEXT[status] ?? `XorPay 返回 ${status}`;
  return info ? `${text}（${info}）` : text;
}

/** XorPay 返回的 JSON（`expire_in` / `expires_in` 两种写法都兼容） */
interface XorpayResponse {
  status?: unknown;
  aoid?: unknown;
  expire_in?: unknown;
  expires_in?: unknown;
  info?: unknown;
  msg?: unknown;
}

/** 下单失败时抛它：`status` 是 XorPay 的错误码，路由层据此给用户提示 */
export class XorpayRequestError extends Error {
  constructor(
    readonly status: string,
    readonly info = '',
  ) {
    super(xorpayErrorText(status, info));
    this.name = 'XorpayRequestError';
  }
}

async function parseXorpayJson(response: Response): Promise<XorpayResponse> {
  try {
    return (await response.json()) as XorpayResponse;
  } catch {
    throw badGateway('XorPay 返回的不是 JSON', 'xorpay_bad_response');
  }
}

function infoText(info: unknown): string {
  return typeof info === 'string' ? info : '';
}

function qrOf(info: unknown): string {
  if (info && typeof info === 'object' && !Array.isArray(info)) {
    const qr = (info as Record<string, unknown>).qr;
    if (typeof qr === 'string') return qr;
  }
  return '';
}

export interface XorpayCreatedOrder {
  /** XorPay 平台订单号 */
  aoid: string;
  /** 支付二维码内容（微信 `weixin://...` / 支付宝 `https://qr.alipay.com/...`） */
  qr: string;
  /** 订单过期秒数 */
  expireIn: number;
}

/**
 * 下单：POST {base}/api/pay/{aid}（表单编码）。
 * 我们的订单号 `orderId` 会在 XorPay 侧做唯一键（同一个 order_id 换参数会返回 `order_exist`）。
 */
export async function xorpayCreateOrder(
  env: Env,
  input: {
    payType: XorpayPayType | string;
    name: string;
    amountCents: number;
    orderId: string;
    orderUid?: string;
    more?: string;
    notifyUrl: string;
  },
): Promise<XorpayCreatedOrder> {
  const payType = asXorpayPayType(input.payType);
  const price = priceTextOf(input.amountCents);
  const body = new URLSearchParams();
  body.set('name', input.name);
  body.set('pay_type', payType);
  body.set('price', price);
  body.set('order_id', input.orderId);
  if (input.orderUid) body.set('order_uid', input.orderUid);
  if (input.more) body.set('more', input.more);
  body.set('notify_url', input.notifyUrl);
  body.set('expire', String(ORDER_TTL_SECONDS));
  body.set(
    'sign',
    createOrderSign(env, {
      payType,
      name: input.name,
      price,
      orderId: input.orderId,
      notifyUrl: input.notifyUrl,
    }),
  );

  let response: Response;
  try {
    response = await fetch(`${xorpayApiBase(env)}/api/pay/${encodeURIComponent(aidOf(env))}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    throw badGateway(
      `连不上 XorPay：${cause instanceof Error ? cause.message : '网络错误'}`,
      'xorpay_unreachable',
    );
  }
  const payload = await parseXorpayJson(response);
  const status = typeof payload.status === 'string' ? payload.status : '';
  if (status !== 'ok') {
    throw new XorpayRequestError(status || 'unknown', infoText(payload.info ?? payload.msg));
  }

  const qr = qrOf(payload.info);
  if (!qr) throw badGateway('XorPay 没有返回支付二维码', 'xorpay_no_qr');
  const expireIn = Number(payload.expire_in ?? payload.expires_in);
  return {
    aoid: typeof payload.aoid === 'string' ? payload.aoid : '',
    qr,
    expireIn: Number.isFinite(expireIn) && expireIn > 0 ? Math.trunc(expireIn) : ORDER_TTL_SECONDS,
  };
}

/**
 * 查单（按我们自己的订单号）：GET {base}/api/query2/{aid}?order_id=&sign=。
 * 返回 XorPay 的状态文本：not_exist / new / payed / fee_error / success / expire。
 */
export async function xorpayQueryOrder(env: Env, orderId: string): Promise<string> {
  const query = new URLSearchParams();
  query.set('order_id', orderId);
  query.set('sign', querySignOf(env, orderId));
  let response: Response;
  try {
    response = await fetch(`${xorpayApiBase(env)}/api/query2/${encodeURIComponent(aidOf(env))}?${query}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (cause) {
    throw badGateway(
      `连不上 XorPay：${cause instanceof Error ? cause.message : '网络错误'}`,
      'xorpay_unreachable',
    );
  }
  const payload = await parseXorpayJson(response);
  return typeof payload.status === 'string' ? payload.status : '';
}
```

### 6.3 `src/worker/orders.ts`（新建：下单 / 交付 / 查单兜底）

> 为什么不把这些写进路由文件：路由文件只做 HTTP，`orders.ts` 只做业务 ——
> 这样 `routes/quota.ts` 与 `routes/payments.ts` 都能复用它，且**不会形成循环依赖**
> （`orders.ts` 不导入任何 `routes/*`，最新名额由路由层自己调 `loadTableQuota()` 拼进响应）。

```ts
/**
 * 表格名额的支付订单：下单、交付（写 table_purchases 加名额）、查单兜底与自愈。
 *
 * 三种情形：
 *   1) 没配 XorPay（XORPAY_AID / XORPAY_APP_SECRET 缺失）= **自助直通**：
 *      下单即交付，channel = 'self-serve'（本地开发 / CI / 资质审核期都走这条，行为与接入前一致）；
 *   2) 配了 XorPay：下单写 pending 订单 + 调网关拿二维码，等回调（或主动查单）再交付；
 *   3) 管理员赠额：直接交付，channel = 'admin-grant'（客服补偿 / 活动赠送 / 冒烟测试建表用）。
 *
 * 幂等：交付前先做一次「状态守卫」更新
 *   UPDATE table_orders SET status='paid' WHERE id=? AND status<>'paid'
 * 只有 changes > 0 的那一次才继续写名额；`table_purchases.order_id` 上的部分唯一索引是第二道闸。
 */
import { MAX_PURCHASE_COUNT } from '../shared/quota';
import {
  BUYABLE_TABLE_KINDS,
  MAX_PURCHASE_MONTHS,
  MIN_PURCHASE_MONTHS,
  isPurchasableMonths,
  purchaseAmountCents,
  purchaseMonthsLabel,
  tableKindLabel,
} from '../shared/tableKind';
import {
  MAX_ORDER_AMOUNT_CENTS,
  ORDER_TTL_MINUTES,
  asXorpayPayType,
  xorpayPayTypeLabel,
  type TableOrderStatus,
  type XorpayPayType,
} from '../shared/xorpay';
import type { TableKind, TableOrder, TablePurchase } from '../shared/types';
import {
  asEnum,
  asNumberValue,
  asString,
  badRequest,
  newId,
  sqlNumber,
  sqlString,
  type SqlRow,
} from './http';
import {
  enabledPayTypes,
  notifyUrlOf,
  xorpayConfigured,
  xorpayCreateOrder,
  xorpayQueryOrder,
  XorpayRequestError,
} from './xorpay';
import type { AuthedUser, Env } from './types';

/** 可以买的类型（试用表格是免费送的、不单卖，见 shared/tableKind.ts） */
const PURCHASE_KINDS = BUYABLE_TABLE_KINDS;

/** 一次购买的参数（说明弹窗里选好的：类型 / 数量 / 总时长 + 可选备注） */
export interface PurchaseInput {
  kind: TableKind;
  count: number;
  months: number;
  note: string;
}

/**
 * 校验一次购买的参数 —— 与接入支付之前的 `purchaseHandler` **逐字一致**
 * （冒烟测试里的 400 断言依赖这些边界：试用表格 400、数量 1 ~ 10、总月数白名单）。
 */
export function parsePurchaseInput(body: Record<string, unknown>): PurchaseInput {
  const kind: TableKind = asEnum(body.kind ?? 'basic', PURCHASE_KINDS, '表格类型');
  const count = Math.floor(asNumberValue(body.count ?? 1, '购买数量'));
  if (count < 1) throw badRequest('购买数量至少 1 个');
  if (count > MAX_PURCHASE_COUNT) throw badRequest(`一次最多购买 ${MAX_PURCHASE_COUNT} 个名额`);
  const months = Math.floor(asNumberValue(body.months ?? 1, '购买时长'));
  if (!isPurchasableMonths(months)) {
    throw badRequest(
      `购买时长只能选 ${MIN_PURCHASE_MONTHS} ~ 12 个月（时长单位「月」× 时长数量 1 ~ 12），或 12 / 24 / 36 / 48 / ${MAX_PURCHASE_MONTHS} 个月（时长单位「年」× 时长数量 1 ~ 5）`,
    );
  }
  const note = asString(body.note, '备注', { max: 200 });
  return { kind, count, months, note };
}

/** 数据库行 → `TableOrder` */
export function orderOf(row: SqlRow): TableOrder {
  const paidAt = sqlNumber(row, 'paid_at', 0);
  return {
    id: sqlString(row, 'id'),
    userId: sqlString(row, 'user_id'),
    kind: sqlString(row, 'kind', 'basic') as TableKind,
    count: sqlNumber(row, 'count', 1),
    months: sqlNumber(row, 'months', 1),
    amountCents: sqlNumber(row, 'amount_cents'),
    paidCents: sqlNumber(row, 'paid_cents'),
    status: sqlString(row, 'status', 'pending') as TableOrderStatus,
    payType: sqlString(row, 'pay_type') as XorpayPayType | '',
    channel: sqlString(row, 'channel'),
    aoid: sqlString(row, 'aoid'),
    qr: sqlString(row, 'qr'),
    expiresAt: sqlNumber(row, 'expires_at'),
    paidAt: paidAt > 0 ? paidAt : null,
    createdAt: sqlNumber(row, 'created_at'),
  };
}

const ORDER_COLUMNS = `id, user_id, kind, count, months, amount_cents, paid_cents, status, pay_type,
  channel, aoid, qr, purchase_id, expires_at, paid_at, created_at`;

/** 按订单号读一行（`userId` 传了就顺带校验归属，防止越权看别人的订单） */
export async function loadOrderRow(env: Env, orderId: string, userId?: string): Promise<SqlRow | null> {
  const statement = userId
    ? env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM table_orders WHERE id = ? AND user_id = ?`).bind(orderId, userId)
    : env.DB.prepare(`SELECT ${ORDER_COLUMNS} FROM table_orders WHERE id = ?`).bind(orderId);
  return (await statement.first<SqlRow>()) ?? null;
}

/** 订单号 = 主键：`vs` 前缀 + 32 位十六进制（同时作为 XorPay 的 order_id，平台侧要求唯一） */
function newOrderId(): string {
  return `vs${newId().replace(/-/g, '')}`;
}

/** 写一条购买流水（名额的真正来源），返回流水 id */
async function insertPurchase(
  env: Env,
  input: {
    userId: string;
    kind: TableKind;
    count: number;
    months: number;
    amountCents: number;
    channel: string;
    note: string;
    createdBy: string;
    orderId?: string;
    createdAt: number;
  },
): Promise<string> {
  const id = newId();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO table_purchases
       (id, user_id, kind, count, months, amount_cents, channel, note, created_by, created_at, order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.userId,
      input.kind,
      input.count,
      input.months,
      input.amountCents,
      input.channel,
      input.note,
      input.createdBy,
      input.createdAt,
      input.orderId ?? '',
    )
    .run();
  return id;
}

export interface CreatedOrder {
  order: TableOrder;
  /** 自助直通 / 赠额时立刻写好的流水；走网关时是 null（等回调到账） */
  purchase: TablePurchase | null;
  /** 走网关时给前端的支付信息（二维码内容） */
  pay: { payType: XorpayPayType; qr: string } | null;
}

/**
 * 下单：服务端算价 → 写订单 →（配了 XorPay）调网关拿二维码。
 * 没配 XorPay 时退化成「自助直通」：立刻交付名额并把流水一起返回。
 */
export async function createOrderForUser(
  env: Env,
  user: AuthedUser,
  input: PurchaseInput,
  options: { request: Request; payType?: unknown },
): Promise<CreatedOrder> {
  const amountCents = purchaseAmountCents(input.kind, input.count, input.months);
  if (amountCents <= 0) throw badRequest('这一类表格不单卖（试用表格是免费赠送的）');
  const now = Date.now();
  const orderId = newOrderId();

  // ---- 情形 1：没配支付 → 自助直通（与接入前完全一致：立刻写流水、立刻加名额）----
  if (!xorpayConfigured(env)) {
    await env.DB.prepare(
      `INSERT INTO table_orders
         (id, user_id, kind, count, months, amount_cents, paid_cents, status, pay_type, channel,
          aoid, qr, transaction_id, buyer, notify_raw, purchase_id, expires_at, paid_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'paid', '', 'self-serve', '', '', '', '', '', '', 0, ?, ?, ?)`,
    )
      .bind(orderId, user.id, input.kind, input.count, input.months, amountCents, amountCents, now, now, now)
      .run();
    const purchaseId = await insertPurchase(env, {
      userId: user.id,
      kind: input.kind,
      count: input.count,
      months: input.months,
      amountCents,
      channel: 'self-serve',
      note: input.note,
      createdBy: user.id,
      orderId,
      createdAt: now,
    });
    await env.DB.prepare('UPDATE table_orders SET purchase_id = ?, updated_at = ? WHERE id = ?')
      .bind(purchaseId, Date.now(), orderId)
      .run();
    const row = await loadOrderRow(env, orderId, user.id);
    return {
      order: orderOf(row ?? {}),
      purchase: {
        id: purchaseId,
        userId: user.id,
        kind: input.kind,
        count: input.count,
        months: input.months,
        amountCents,
        channel: 'self-serve',
        note: input.note,
        createdAt: now,
      },
      pay: null,
    };
  }

  // ---- 情形 2：配了支付 → 写 pending 订单 + 调网关拿二维码，等回调交付 ----
  const payTypes = enabledPayTypes(env);
  const payType: XorpayPayType = asXorpayPayType(
    options.payType === undefined || options.payType === '' ? payTypes[0] : options.payType,
  );
  if (!payTypes.includes(payType)) {
    throw badRequest(`${xorpayPayTypeLabel(payType)}支付暂不可用，请换一种支付方式`, 'pay_type_unavailable');
  }
  if (amountCents > MAX_ORDER_AMOUNT_CENTS) {
    // 渠道有单笔限额（支付宝当面付个人单笔 ¥1000），别把用户送到支付页再失败
    throw badRequest(
      `单笔最多 ${MAX_ORDER_AMOUNT_CENTS / 100} 元（${xorpayPayTypeLabel(payType)}扫码单笔限额），请减少数量或时长后分多笔购买`,
      'order_amount_too_large',
    );
  }

  const expiresAt = now + ORDER_TTL_MINUTES * 60 * 1000;
  await env.DB.prepare(
    `INSERT INTO table_orders
       (id, user_id, kind, count, months, amount_cents, status, pay_type, channel, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'xorpay', ?, ?, ?)`,
  )
    .bind(orderId, user.id, input.kind, input.count, input.months, amountCents, payType, expiresAt, now, now)
    .run();

  try {
    const created = await xorpayCreateOrder(env, {
      payType,
      // 商品名会显示在微信 / 支付宝的账单上，写清楚「买了什么」
      name: `${tableKindLabel(input.kind)}名额 × ${input.count}（${purchaseMonthsLabel(input.months)}）`,
      amountCents,
      orderId,
      // order_uid 是可选参数，用来在 XorPay 后台看清是谁下的单
      orderUid: user.email,
      more: `${input.kind}:${input.count}:${input.months}`,
      notifyUrl: notifyUrlOf(env, options.request),
    });
    await env.DB.prepare(
      'UPDATE table_orders SET aoid = ?, qr = ?, expires_at = ?, updated_at = ? WHERE id = ?',
    )
      .bind(created.aoid, created.qr, now + created.expireIn * 1000, Date.now(), orderId)
      .run();
    const row = await loadOrderRow(env, orderId, user.id);
    return { order: orderOf(row ?? {}), purchase: null, pay: { payType, qr: created.qr } };
  } catch (error) {
    // 下单失败：订单标成 canceled 并把错误文本留在 notify_raw 里（不删，方便排障）
    const message =
      error instanceof XorpayRequestError
        ? `${error.status} ${error.message}`
        : error instanceof Error
          ? error.message
          : 'unknown';
    await env.DB.prepare(
      `UPDATE table_orders SET status = 'canceled', notify_raw = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(message.slice(0, 500), Date.now(), orderId)
      .run();
    throw error;
  }
}

/**
 * 交付一张订单：状态守卫 → 写购买流水 → 回写 purchase_id。
 * 返回 true = 这一次真的交付了；false = 已经交付过（重复回调 / 并发调用）。
 */
export async function deliverOrder(
  env: Env,
  order: TableOrder,
  paid: {
    paidCents: number;
    transactionId?: string;
    buyer?: string;
    notifyRaw?: string;
    /** notify = 回调确认；query = 主动查单确认 */
    source: 'notify' | 'query';
  },
): Promise<boolean> {
  const now = Date.now();
  const guard = await env.DB.prepare(
    `UPDATE table_orders
        SET status = 'paid', paid_cents = ?, transaction_id = ?, buyer = ?, notify_raw = ?, paid_at = ?, updated_at = ?
      WHERE id = ? AND status <> 'paid'`,
  )
    .bind(
      paid.paidCents,
      paid.transactionId ?? '',
      paid.buyer ?? '',
      (paid.notifyRaw ?? '').slice(0, 500),
      now,
      now,
      order.id,
    )
    .run();
  // 只有把 pending / expired / canceled 改成 paid 的那一次（changes = 1）才继续交付
  if (Number(guard.meta?.changes ?? 0) === 0) return false;

  const channel =
    order.channel === 'self-serve' || order.channel === 'admin-grant'
      ? order.channel
      : `${order.channel || 'xorpay'}:${order.payType || 'native'}`;
  const purchaseId = await insertPurchase(env, {
    userId: order.userId,
    kind: order.kind,
    count: order.count,
    months: order.months,
    amountCents: order.amountCents,
    channel,
    note: paid.source === 'notify' ? '支付到账（XorPay 回调）' : '支付到账（主动查单确认）',
    createdBy: order.userId,
    orderId: order.id,
    createdAt: now,
  });
  await env.DB.prepare('UPDATE table_orders SET purchase_id = ?, updated_at = ? WHERE id = ?')
    .bind(purchaseId, now, order.id)
    .run();
  return true;
}

/** 自愈：订单已经是 paid 但没记 purchase_id（上次写入中途失败）→ 补一条流水 */
async function healPaidOrder(env: Env, row: SqlRow): Promise<void> {
  if (sqlString(row, 'status') !== 'paid' || sqlString(row, 'purchase_id') !== '') return;
  const order = orderOf(row);
  const existing = await env.DB.prepare('SELECT id FROM table_purchases WHERE order_id = ?')
    .bind(order.id)
    .first<SqlRow>();
  const purchaseId = existing
    ? sqlString(existing, 'id')
    : await insertPurchase(env, {
        userId: order.userId,
        kind: order.kind,
        count: order.count,
        months: order.months,
        amountCents: order.amountCents,
        channel:
          order.channel === 'self-serve'
            ? 'self-serve'
            : `${order.channel || 'xorpay'}:${order.payType || 'native'}`,
        note: '支付到账（补记）',
        createdBy: order.userId,
        orderId: order.id,
        createdAt: Date.now(),
      });
  await env.DB.prepare('UPDATE table_orders SET purchase_id = ?, updated_at = ? WHERE id = ?')
    .bind(purchaseId, Date.now(), order.id)
    .run();
}

/** 待支付订单超时 → expired（只在还是 pending 时改，不会覆盖 paid） */
async function markExpired(env: Env, orderId: string): Promise<void> {
  await env.DB.prepare(`UPDATE table_orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'`)
    .bind(Date.now(), orderId)
    .run();
}

/**
 * 查单兜底：前端轮询 / 用户手动刷新时打一次 XorPay，
 * 回调因为网络原因丢了也能自己把名额补上（`payed` = 已支付但通知还没成功，一样交付）。
 */
export async function syncOrderWithGateway(env: Env, row: SqlRow): Promise<SqlRow> {
  const order = orderOf(row);

  // ① 已经交付过：顺手做一次自愈（防止「状态改了、流水没写成」）
  if (order.status === 'paid') {
    await healPaidOrder(env, row);
    return (await loadOrderRow(env, order.id)) ?? row;
  }
  if (order.status !== 'pending' || !xorpayConfigured(env)) return row;

  // ② 主动查单
  const status = await xorpayQueryOrder(env, order.id);
  if (status === 'success' || status === 'payed') {
    // 查单接口不返回金额（金额在下单时就锁定，且同一个 order_id 不能改金额），
    // 所以这里按订单金额交付，并在流水里写明来源是「主动查单确认」。
    await deliverOrder(env, order, { paidCents: order.amountCents, source: 'query' });
  } else if (status === 'expire' || (status === 'not_exist' && Date.now() >= order.expiresAt)) {
    await markExpired(env, order.id);
  } else if (status === 'new' && Date.now() >= order.expiresAt) {
    // 网关那边还没付款、我们这边的有效期也过了 → 本地标记过期（要买会重新下单）
    await markExpired(env, order.id);
  }
  return (await loadOrderRow(env, order.id)) ?? row;
}

export interface NotifyInput {
  orderId: string;
  aoid: string;
  /** 实付金额（分）；`null` = 回调里的 pay_price 解析失败 */
  paidCents: number | null;
  transactionId: string;
  buyer: string;
  /** 回调原文（截断保存，排障用） */
  raw: string;
}

export type NotifyOutcome = 'delivered' | 'duplicate' | 'amount_mismatch' | 'unknown_order';

/**
 * 处理一次支付回调：金额核对 → 交付（幂等）。
 * 金额不符**不交付**、标记 `amount_mismatch` 等人工（防止「付 0.01 元拿 10 个名额」）。
 */
export async function deliverFromNotify(env: Env, input: NotifyInput): Promise<NotifyOutcome> {
  const row = await loadOrderRow(env, input.orderId);
  if (!row) return 'unknown_order';
  const order = orderOf(row);

  if (input.paidCents === null || input.paidCents !== order.amountCents) {
    await env.DB.prepare(
      `UPDATE table_orders
          SET status = 'amount_mismatch', paid_cents = ?, aoid = ?, notify_raw = ?, updated_at = ?
        WHERE id = ?`,
    )
      .bind(input.paidCents ?? 0, input.aoid, input.raw.slice(0, 500), Date.now(), input.orderId)
      .run();
    console.error(`[xorpay] 金额不符：order=${input.orderId} expected=${order.amountCents} paid=${input.paidCents}`);
    return 'amount_mismatch';
  }

  if (order.status === 'paid') {
    // 重复回调（XorPay 通知失败会重试 6 次）：只刷新回调痕迹，不再交付
    await env.DB.prepare(
      `UPDATE table_orders SET aoid = ?, transaction_id = ?, buyer = ?, notify_raw = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(input.aoid, input.transactionId, input.buyer, input.raw.slice(0, 500), Date.now(), input.orderId)
      .run();
    return 'duplicate';
  }

  // 钱已到账就给名额：订单即使已经 canceled / expired 也一样交付
  const delivered = await deliverOrder(env, order, {
    paidCents: input.paidCents,
    transactionId: input.transactionId,
    buyer: input.buyer,
    notifyRaw: input.raw,
    source: 'notify',
  });
  return delivered ? 'delivered' : 'duplicate';
}

/**
 * 管理员赠额：跳过支付直接写一条流水（客服补偿 / 活动赠送；
 * 线上接入支付后，冒烟测试也靠它给测试账号发建表名额，见 §8）。
 */
export async function grantQuota(
  env: Env,
  input: { userId: string; kind: TableKind; count: number; months: number; note: string; createdBy: string },
): Promise<TablePurchase> {
  const amountCents = purchaseAmountCents(input.kind, input.count, input.months);
  const now = Date.now();
  const id = await insertPurchase(env, {
    userId: input.userId,
    kind: input.kind,
    count: input.count,
    months: input.months,
    amountCents,
    channel: 'admin-grant',
    note: input.note,
    createdBy: input.createdBy,
    createdAt: now,
  });
  return {
    id,
    userId: input.userId,
    kind: input.kind,
    count: input.count,
    months: input.months,
    amountCents,
    channel: 'admin-grant',
    note: input.note,
    createdAt: now,
  };
}
```

### 6.4 `src/worker/routes/payments.ts`（新建：下单 / 查单 / 回调）

```ts
/**
 * 支付路由：
 *   POST /api/quota/orders       下单（返回订单；配了 XorPay 时带支付二维码，未配则立即交付）
 *   GET  /api/quota/orders/:id   查单（顺带向 XorPay 兜底查询 + 自愈，前端轮询它）
 *   POST /api/xorpay/notify      XorPay 异步回调（验签 + 金额核对 + 幂等交付，必须回 200）
 *
 * 回调是**匿名**请求（XorPay 服务器直连，没有 Cookie），所以它自己验签、不要求登录；
 * 另外两条仍是登录用户接口（`requireUser`）。返回给回调的响应必须是纯文本 + HTTP 200，
 * 否则 XorPay 会按 1/2/4/16/64/300 分钟重试 6 次（notify.html）。
 */
import { orderStatusText } from '../../shared/xorpay';
import { requireUser } from '../auth';
import { json, notFound, readJson, type SqlRow } from '../http';
import {
  createOrderForUser,
  deliverFromNotify,
  loadOrderRow,
  orderOf,
  parsePurchaseInput,
  syncOrderWithGateway,
} from '../orders';
import { notifySignOf, priceCentsOf, xorpayConfigured } from '../xorpay';
import type { RequestContext, Route } from '../types';
import { loadTableQuota } from './quota';

/** 下单一单一：201 = 自助直通已到账（带 `purchase`）；202 = 待支付（带 `pay.qr`） */
async function createOrderHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const input = parsePurchaseInput(body);
  const created = await createOrderForUser(ctx.env, user, input, {
    request: ctx.request,
    payType: body.payType,
  });
  return json(
    {
      order: created.order,
      purchase: created.purchase,
      pay: created.pay,
      /** 是否已开通在线支付：前端据此显示「扫码支付」还是「已到账」 */
      paymentEnabled: xorpayConfigured(ctx.env),
      quota: await loadTableQuota(ctx.env, user.id),
    },
    { status: created.purchase ? 201 : 202 },
  );
}

/** 查单：先看库里，再（配了支付时）向 XorPay 兜底查一次 + 交付/过期，返回最新状态 */
async function orderStatusHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const row = await loadOrderRow(ctx.env, ctx.params.id ?? '', user.id);
  if (!row) throw notFound('订单不存在');

  let fresh: SqlRow = row;
  try {
    fresh = await syncOrderWithGateway(ctx.env, row);
  } catch (error) {
    // 查单只是兜底：网关不通 / 被风控时不要把轮询整个打失败，返回库里最新的状态即可
    console.warn('[xorpay] 查单失败：', error instanceof Error ? error.message : error);
  }
  const order = orderOf(fresh);
  return json({
    order,
    statusText: orderStatusText(order.status),
    quota: await loadTableQuota(ctx.env, user.id),
  });
}

/** 回调只认状态码与文本内容：回纯文本（`ok` / `success` 都算成功），别回 JSON */
function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** 回调里的 `detail` 是 JSON 文本（`transaction_id` / `bank_type` / `buyer`） */
function parseDetail(raw: string): { transactionId: string; buyer: string } {
  if (!raw) return { transactionId: '', buyer: '' };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      transactionId: typeof parsed.transaction_id === 'string' ? parsed.transaction_id : '',
      buyer: typeof parsed.buyer === 'string' ? parsed.buyer : '',
    };
  } catch {
    return { transactionId: '', buyer: '' };
  }
}

/** 把回调原文拼成一条可读记录（去掉 sign，截断保存） */
function notifyRawOf(form: FormData): string {
  const parts: string[] = [];
  form.forEach((value, key) => {
    if (key !== 'sign') parts.push(`${key}=${String(value)}`);
  });
  return parts.join('&').slice(0, 500);
}

async function notifyHandler(ctx: RequestContext): Promise<Response> {
  const env = ctx.env;
  // 没配支付就没人会回调我们：当成 404，避免被误触发
  if (!xorpayConfigured(env)) return textResponse('payment not configured', 404);

  const contentType = ctx.request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    return textResponse('bad content type', 400);
  }

  let form: FormData;
  try {
    form = await ctx.request.formData();
  } catch {
    return textResponse('bad form body', 400);
  }
  const read = (key: string) => {
    const value = form.get(key);
    return typeof value === 'string' ? value : '';
  };

  const aoid = read('aoid');
  const orderId = read('order_id');
  const payPrice = read('pay_price');
  const payTime = read('pay_time');
  const sign = read('sign').toLowerCase();
  if (!aoid || !orderId || !payPrice || !payTime || !sign) return textResponse('missing argument', 400);

  // 验签：md5(aoid + order_id + pay_price + pay_time + app_secret)
  const expected = notifySignOf(env, { aoid, orderId, payPrice, payTime });
  if (expected !== sign) {
    console.error(`[xorpay] 回调验签失败：order=${orderId} sign=${sign}`);
    return textResponse('sign error', 400);
  }

  const detail = parseDetail(read('detail'));
  const outcome = await deliverFromNotify(env, {
    orderId,
    aoid,
    paidCents: priceCentsOf(payPrice),
    transactionId: detail.transactionId,
    buyer: detail.buyer,
    raw: notifyRawOf(form),
  });

  if (outcome === 'unknown_order') {
    // 签名对得上但订单不在本库（换过数据库 / 人工测试）→ 回 200 停止重试，人工对账
    console.error(`[xorpay] 回调里的订单不存在：${orderId}`);
    return textResponse('unknown order', 200);
  }
  // delivered / duplicate / amount_mismatch 都回 200：
  // 金额不符是永久性错误，重试 6 次也没用，靠日志与后台订单表人工处理。
  return textResponse('success', 200);
}

export const paymentRoutes: Route[] = [
  { method: 'POST', path: '/api/quota/orders', handler: createOrderHandler },
  { method: 'GET', path: '/api/quota/orders/:id', handler: orderStatusHandler },
  { method: 'POST', path: '/api/xorpay/notify', handler: notifyHandler },
];
```

### 6.5 改 `src/worker/routes/quota.ts`（老接口保留，改成「下单」的简写）

`loadTableQuota()` **原样不动**（它是名额的唯一权威口径，被会话下发与各路由共用）。
只改这几处：

1. 文件头注释补一段「购买现在走订单」；
2. 导入调整：

```ts
// 之前：import { MAX_PURCHASE_COUNT, tableQuotaSetOf } from '../../shared/quota';
import { tableQuotaSetOf } from '../../shared/quota';
// 之前那一大串价格 / 时长白名单的导入搬去 src/worker/orders.ts（`parsePurchaseInput` 里用）
import { createOrderForUser, parsePurchaseInput } from '../orders';
```

3. `purchaseHandler` 整个替换成：

```ts
/**
 * 老接口：`POST /api/quota/purchases`（body `{ kind, count, months, note? }`）。
 *
 * 接入 XorPay 之后它只是「下单」的简写，行为取决于有没有配支付：
 *   - **没配支付**（本地 / CI / 资质审核期）：与接入前逐字节一样 —— 立刻写流水、立刻加名额，
 *     返回 201 `{ quota, purchase }`；
 *   - **配了支付**：返回 202 `{ quota, order, pay }`（`pay.qr` 是支付二维码），名额要等回调 / 查单
 *     确认后才到账。前端已改走 `POST /api/quota/orders`，这里留着只为兼容老客户端与冒烟测试。
 */
async function purchaseHandler(ctx: RequestContext): Promise<Response> {
  const user = await requireUser(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const input = parsePurchaseInput(body);
  const created = await createOrderForUser(ctx.env, user, input, {
    request: ctx.request,
    payType: body.payType,
  });
  return json(
    {
      quota: await loadTableQuota(ctx.env, user.id),
      purchase: created.purchase,
      order: created.order,
      pay: created.pay,
    },
    { status: created.purchase ? 201 : 202 },
  );
}
```

> `noUnusedLocals` 会盯着导入列表：`BUYABLE_TABLE_KINDS` / `MAX_PURCHASE_MONTHS` /
> `MIN_PURCHASE_MONTHS` / `isPurchasableMonths` / `purchaseAmountCents` / `MAX_PURCHASE_COUNT` /
> `asEnum` / `asNumberValue` / `asString` / `badRequest` / `newId` / `TablePurchase` 这些
> 都随逻辑搬去 `orders.ts` 了，记得从 `quota.ts` 的 import 里删掉（`npm run typecheck` 会报）。
> `quotaRoutes` 的两条路由不变。

### 6.6 注册路由与补 Env 类型

`src/worker/types.ts` 的 `Env` 里补 5 个字段：

```ts
  /**
   * XorPay 收款（https://xorpay.com）。`XORPAY_AID` + `XORPAY_APP_SECRET` 两个都配齐才算
   * 「已开通在线支付」；否则购买走自助直通（本地开发 / CI / 资质审核期）。
   * 线上用 `npx wrangler secret put XORPAY_AID`（或仓库 Secret，CI 自动同步），见 DEPLOY.md。
   */
  XORPAY_AID?: string;
  /** XorPay 的 app secret：下单签名与回调验签都用它（secret） */
  XORPAY_APP_SECRET?: string;
  /** XorPay 接口基址，默认 https://xorpay.com；本地联调可指向假服务器 */
  XORPAY_API_BASE?: string;
  /** 开放的支付方式，逗号分隔（默认 native,alipay）——线上想临时只留一个通道时改它 */
  XORPAY_PAY_TYPES?: string;
  /** 生成 XorPay 回调地址用的公网基址，例如 https://varysheet.com（强烈建议线上配） */
  PUBLIC_BASE_URL?: string;
```

`src/worker/index.ts` 注册路由（注意放在 `quotaRoutes` 之后，语义上紧跟名额）：

```ts
import { paymentRoutes } from './routes/payments';
// ...
const API_ROUTES: Route[] = [
  ...authRoutes,
  ...brandingRoutes,
  ...inviteRoutes,
  ...adminRoutes,
  ...shardRoutes,
  ...quotaRoutes,
  ...paymentRoutes, // 表格名额下单 / 查单 / XorPay 回调
  ...databaseRoutes,
  // ...
];
```

`src/worker/routes/admin.ts` 增加管理员赠额（客服补偿 / 活动赠送 / 冒烟测试建表都用它）：

```ts
/**
 * 管理员赠额：给某个账号加名额，不产生订单、不走支付 —— 写一条 `channel = 'admin-grant'` 的流水。
 * body `{ email, kind, count, months, note? }`：金额按现价记（对账口径统一），也可以直接调它补偿用户。
 */
async function grantQuotaHandler(ctx: RequestContext): Promise<Response> {
  // admin.ts 里现有写法就是 `await requireAdmin(ctx.request, ctx.env)`，它返回管理员账号本身
  const admin = await requireAdmin(ctx.request, ctx.env);
  const body = await readJson(ctx.request);
  const email = normalizeEmail(body.email);
  const input = parsePurchaseInput(body);
  const target = await ctx.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<SqlRow>();
  if (!target) throw notFound('用户不存在');
  const purchase = await grantQuota(ctx.env, {
    userId: sqlString(target, 'id'),
    kind: input.kind,
    count: input.count,
    months: input.months,
    note: input.note || `管理员赠额（${admin.email}）`,
    createdBy: admin.id,
  });
  return json({ purchase, quota: await loadTableQuota(ctx.env, sqlString(target, 'id')) }, { status: 201 });
}
```

并加进 `adminRoutes`：

```ts
  { method: 'POST', path: '/api/admin/quota/grants', handler: grantQuotaHandler },
```

> ⚠️ 三个新路由（`/api/quota/orders`、`/api/quota/orders/:id`、`/api/xorpay/notify`）
> 与 `/api/admin/quota/grants` 都要过 `npm run check:routes`：handler 必须与路由表在同一个文件里定义、
> 不能与已有路由撞形状。

---

## 7. 前端：API 封装 + 购买弹窗（二维码 + 轮询）

### 7.1 `src/client/api.ts`（补两个方法 + 两个类型）

```ts
/** 下单响应：`purchase` 有值 = 已经到账（没配支付）；`pay.qr` 有值 = 等扫码付款 */
export interface QuotaOrderResponse {
  order: TableOrder;
  purchase: TablePurchase | null;
  pay: { payType: XorpayPayType; qr: string } | null;
  /** 站点是否已开通在线支付（线上配了 XorPay 就是 true） */
  paymentEnabled: boolean;
  quota: TableQuotaSet;
}

/** 查单响应：前端每 3 秒轮询一次，到账后自己关掉二维码 */
export interface QuotaOrderStatus {
  order: TableOrder;
  /** 状态中文文案，见 shared/xorpay.ts 的 `orderStatusText()` */
  statusText: string;
  quota: TableQuotaSet;
}

// —— 加进 api 对象（放在 `purchaseQuota` 旁边）——
  /**
   * 下单买名额。
   * - 没配 XorPay（本地 / CI）：201 + `purchase`（立刻到账）；
   * - 配了 XorPay：202 + `pay.qr`（微信 `weixin://...` / 支付宝 `https://qr.alipay.com/...`），
   *   要等回调或查单确认才有名额。
   */
  createQuotaOrder: (body: { kind: TableKind; count: number; months: number; payType?: XorpayPayType; note?: string }) =>
    json<QuotaOrderResponse>('/api/quota/orders', 'POST', body),
  /** 查一张订单（顺带让服务端向 XorPay 兜底查一次，回调丢了也能补到账） */
  quotaOrder: (id: string) => json<QuotaOrderStatus>(`/api/quota/orders/${encodeURIComponent(id)}`, 'GET'),
```

> `purchaseQuota`（老接口）**保留不删**：老客户端可能还在用，服务端也还兼容（§6.5）。
> 弹窗改用 `createQuotaOrder`。

### 7.2 QuotaDialog：加状态与轮询（`src/client/components/Sidebar.tsx`）

```tsx
  /** 支付方式：native（微信扫码）/ alipay（支付宝当面付）—— 两条通道都是「服务端下单拿二维码」 */
  const [payType, setPayType] = useState<XorpayPayType>('native');
  /** 待支付的订单：下单成功后弹窗里显示二维码并开始轮询；到账后自动关闭弹窗 */
  const [pending, setPending] = useState<{
    id: string;
    qr: string;
    payType: XorpayPayType;
    amountCents: number;
  } | null>(null);

  // 每 3 秒查一次订单（最多 100 次 ≈ 5 分钟；订单本身有效期 120 分钟，超时用户点「去支付」重新下单即可）
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let polls = 0;
    const tick = async () => {
      if (cancelled) return;
      polls += 1;
      try {
        const result = await onCheckOrder(pending.id);
        if (cancelled) return;
        if (result.order.status === 'paid') {
          onPaid(result.quota); // App 刷新侧边栏数字 + 弹「支付成功」提示
          onClose();
          return;
        }
        if (result.order.status === 'expired' || result.order.status === 'amount_mismatch') {
          setError(result.statusText);
          setPending(null);
          return;
        }
      } catch {
        // 轮询失败（断网 / 网关抖动）不弹错，等下一次
      }
      if (polls >= 100) setError('还没收到支付结果；已付款的话请重新打开本弹窗查看，或联系客服');
    };
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pending, onCheckOrder, onPaid, onClose]);
```

`submit` 从「购买」改成「下单」：

```tsx
  const submit = async () => {
    if (busy) return;
    // 单笔超限（支付宝当面付个人 ¥1000）就别下单了，直接告诉用户怎么拆
    const overLimit = orderAmountHint(amountCents, payType);
    if (overLimit) {
      setError(overLimit);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await onOrder({ kind, count, months, payType });
      if (result.purchase) {
        // 没配支付（本地 / CI / 资质审核期）：后端立刻到账，行为和接入前一样
        onClose();
        return;
      }
      if (result.pay) {
        setPending({
          id: result.order.id,
          qr: result.pay.qr,
          payType: result.pay.payType,
          amountCents: result.order.amountCents,
        });
      } else {
        setError('下单成功但没拿到支付二维码，请稍后重试或联系客服');
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '下单失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  };
```

### 7.3 QuotaDialog：支付方式、二维码区与 props

购买区里「购买数量」下拉后加一个「支付方式」，按钮文案跟着状态走：

```tsx
        <label className="field">
          <span>支付方式</span>
          <select className="input" value={payType} onChange={(event) => setPayType(asXorpayPayType(event.target.value))}>
            <option value="native">微信扫码</option>
            <option value="alipay">支付宝（扫码，手机可拉起 App）</option>
          </select>
        </label>
        <button
          type="button"
          className="btn primary"
          disabled={busy || pending !== null}
          onClick={() => void submit()}
        >
          {busy ? '下单中…' : pending ? '等待支付…' : '去支付'}
        </button>
```

二维码区（放在「价格：…」那句下面）：

```tsx
      {pending ? (
        <div className="quota-pay">
          <img
            className="quota-pay-qr"
            src={xorpayQrImageUrl(pending.qr)}
            alt={`${xorpayPayTypeLabel(pending.payType)}支付二维码`}
          />
          <p className="small">
            请用{xorpayPayTypeLabel(pending.payType)}
            {pending.payType === 'native' ? '扫一扫' : '扫描二维码'}支付{' '}
            {formatPriceCents(pending.amountCents)}，支付完成后名额自动到账。
          </p>
          {pending.payType === 'alipay' ? (
            // 手机浏览器里可以直接拉起支付宝 App（当面付的 qr 链接本身就是 H5 地址）
            <a className="btn" href={xorpayAlipayDeepLink(pending.qr)}>
              用支付宝打开
            </a>
          ) : null}
          <p className="small muted">
            订单号 {pending.id}（{ORDER_TTL_MINUTES} 分钟内有效）
          </p>
        </div>
      ) : null}
```

弹窗 props：把原来的 `onBuy` 换成三个（下单 / 查单 / 到账回调）：

```tsx
  onOrder: (input: { kind: TableKind; count: number; months: number; payType: XorpayPayType }) =>
    Promise<QuotaOrderResponse>;
  onCheckOrder: (id: string) => Promise<QuotaOrderStatus>;
  /** 轮询到账：把最新名额交给 App（刷新侧边栏数字 + 弹提示），弹窗自己关掉 */
  onPaid: (quota: TableQuotaSet) => void;
```

新增导入（`Sidebar.tsx` 顶部）：

```tsx
import {
  ORDER_TTL_MINUTES,
  asXorpayPayType,
  orderAmountHint,
  xorpayAlipayDeepLink,
  xorpayPayTypeLabel,
  xorpayQrImageUrl,
  type XorpayPayType,
} from '../../shared/xorpay';
```

`src/client/styles.css` 补两条（二维码固定 180px，窄屏不溢出）：

```css
.quota-pay {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.quota-pay-qr {
  width: 180px;
  height: 180px;
  max-width: 100%;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
}
```

### 7.4 `src/client/App.tsx`：`buyQuota` → `orderQuota` + 到账处理

```tsx
  /** 购买区下单：走支付时返回二维码（弹窗自己轮询）；没配支付时后端直接到账 */
  const orderQuota = useCallback(
    async (input: { kind: TableKind; count: number; months: number; payType: XorpayPayType }) => {
      const result = await api.createQuotaOrder(input);
      setQuota(result.quota);
      if (result.purchase) {
        toast(`已购买 ${input.count} 个${tableKindLabel(input.kind)}名额（${purchaseMonthsLabel(input.months)}），现在可以添加了`);
      }
      return result;
    },
    [toast],
  );

  /** 轮询到账：刷新名额并提示（弹窗那边已经自己关了） */
  const handleQuotaPaid = useCallback(
    (next: TableQuotaSet) => {
      setQuota(next);
      toast('支付成功，名额已到账');
    },
    [toast],
  );
```

传给 `Sidebar` 的三个 props：

```tsx
        onOrderQuota={orderQuota}
        onCheckQuotaOrder={(id) => api.quotaOrder(id)}
        onQuotaPaid={handleQuotaPaid}
```

> 提示：`App.tsx` 里 `buyQuota` 这个名字可以直接改名（`onBuyQuota` → `onOrderQuota`），
> 或保留名字只换实现 —— 只要 `Sidebar` 的 props 一一对上即可。

---

## 8. 测试与本地联调

### 8.1 本地假 XorPay：不用真实商户号也能跑通整条链路

新建 `scripts/fake-xorpay.mjs`（约 90 行，只依赖 Node 自带模块）：

```js
#!/usr/bin/env node
/**
 * 本地假 XorPay：把「下单 → 扫码 → 回调 → 到账」整条链路在没有真实商户号时跑通。
 *
 * 用法：
 *   1) .dev.vars 里加
 *        XORPAY_AID=fake_aid
 *        XORPAY_APP_SECRET=fake_secret
 *        XORPAY_API_BASE=http://127.0.0.1:8788
 *   2) 终端 A：node scripts/fake-xorpay.mjs
 *   3) 终端 B：npm run dev（Worker 在 http://127.0.0.1:8787）
 *   4) 应用里点「去支付」→ 得到一张假二维码（内容是 weixin://wxpay/bizpayurl?pr=FAKE-xxx，扫不出来是正常的）
 *   5) 模拟用户付款（这一下会真的回调到你的 Worker）：
 *        curl.exe -X POST http://127.0.0.1:8788/__pay/<订单号>
 *      3 秒内二维码区自己消失、名额到账。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.FAKE_XORPAY_PORT ?? 8788);
const APP_SECRET = process.env.FAKE_XORPAY_SECRET ?? 'fake_secret';
const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

/** order_id → 订单 */
const orders = new Map();

function readForm(request) {
  return new Promise((resolve) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => resolve(new URLSearchParams(raw)));
  });
}

function sendJson(response, payload) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);

  // 下单：POST /api/pay/{aid}
  if (request.method === 'POST' && url.pathname.startsWith('/api/pay/')) {
    const form = await readForm(request);
    const orderId = form.get('order_id') ?? '';
    const expected = md5(
      `${form.get('name')}${form.get('pay_type')}${form.get('price')}${orderId}${form.get('notify_url')}${APP_SECRET}`,
    );
    if (form.get('sign') !== expected) return sendJson(response, { status: 'sign_error' });
    const aoid = randomUUID().replace(/-/g, '');
    orders.set(orderId, {
      aoid,
      price: form.get('price'),
      notifyUrl: form.get('notify_url') ?? '',
      paid: false,
    });
    return sendJson(response, {
      status: 'ok',
      aoid,
      expire_in: 7200,
      info: { qr: `weixin://wxpay/bizpayurl?pr=FAKE-${aoid.slice(0, 12)}` },
    });
  }

  // 查单：GET /api/query2/{aid}?order_id=&sign=
  if (request.method === 'GET' && url.pathname.startsWith('/api/query2/')) {
    const orderId = url.searchParams.get('order_id') ?? '';
    if (url.searchParams.get('sign') !== md5(`${orderId}${APP_SECRET}`)) {
      return sendJson(response, { status: 'sign_error' });
    }
    const order = orders.get(orderId);
    return sendJson(response, { status: order ? (order.paid ? 'success' : 'new') : 'not_exist' });
  }

  // 模拟付款：POST /__pay/{order_id} → 标记已支付 + 按官方格式回调
  if (request.method === 'POST' && url.pathname.startsWith('/__pay/')) {
    const orderId = url.pathname.slice('/__pay/'.length);
    const order = orders.get(orderId);
    if (!order) {
      response.writeHead(404).end('unknown order');
      return;
    }
    order.paid = true;
    const payTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const payload = new URLSearchParams({
      aoid: order.aoid,
      order_id: orderId,
      pay_price: order.price ?? '0.00',
      pay_time: payTime,
      more: '',
      detail: JSON.stringify({
        transaction_id: `FAKE${order.aoid.slice(0, 8)}`,
        bank_type: 'FAKE',
        buyer: 'fake@example.com',
      }),
    });
    payload.set('sign', md5(`${order.aoid}${orderId}${order.price}${payTime}${APP_SECRET}`));
    const notified = await fetch(order.notifyUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: payload,
    })
      .then((res) => `${res.status} ${res.statusText}`)
      .catch((error) => `failed: ${error.message}`);
    console.log(`[fake-xorpay] 回调 ${order.notifyUrl} → ${notified}`);
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`paid ${orderId} (${notified})\n`);
    return;
  }

  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('fake xorpay: POST /api/pay/{aid} | GET /api/query2/{aid} | POST /__pay/{order_id}\n');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-xorpay] http://127.0.0.1:${PORT}（app secret: ${APP_SECRET}）`);
});
```

不想写脚本的话，也可以用 `XORPAY_API_BASE` 直接指向一个 cloudflared / ngrok 隧道做真机小额测试，
但假网关能覆盖「回调重放、金额不符、重复通知」这些边界，**建议两个都跑**。

### 8.2 改 `scripts/smoke-test.mjs`：线上开了支付也能跑

问题：冒烟测试是临时注册的 `smoke+...@example.com`，以前靠 `/api/quota/purchases` 白拿建表名额；
线上配了 XorPay 之后这笔会变成 202（待支付），后面所有「建表」断言会连环失败。

改法（只动 bootstrap 那一段，其余断言一条不动；开通收款后总数从 288 变成 **290**，
多出的两条分别是「下单要在线支付（202 + 二维码）」与「管理员赠额兜底」）：

```js
  // 先用老的「购买」接口探一下：201 = 还没接支付（本地 / CI），202 = 线上已经要付钱了
  const bootstrapSlots = await call('/api/quota/purchases', {
    method: 'POST',
    body: { kind: 'basic', count: 10 },
  });
  if (bootstrapSlots.status === 201) {
    check(
      'buying basic table slots works out of the box',
      bootstrapSlots.data?.purchase?.kind === 'basic' &&
        bootstrapSlots.data?.purchase?.count === 10 &&
        bootstrapSlots.data?.purchase?.months === 1 &&
        bootstrapSlots.data?.purchase?.amountCents === 990 * 10 &&
        bootstrapSlots.data?.quota?.basic?.purchased === 10 &&
        bootstrapSlots.data?.quota?.basic?.remaining === 10,
      `purchased=${bootstrapSlots.data?.quota?.basic?.purchased}`,
    );
  } else {
    // 线上已经接入 XorPay：不再白拿名额，改用管理员赠额接口（同一次运行里的管理员会话）
    check(
      'online payment is required for buying slots',
      bootstrapSlots.status === 202 &&
        typeof bootstrapSlots.data?.pay?.qr === 'string' &&
        bootstrapSlots.data?.purchase === null,
      `status=${bootstrapSlots.status} qr=${Boolean(bootstrapSlots.data?.pay?.qr)}`,
    );
    const granted = await call(
      '/api/admin/quota/grants',
      { method: 'POST', body: { email, kind: 'basic', count: 10, months: 1, note: 'smoke bootstrap' } },
      adminToken,
    );
    check(
      'an admin can grant table slots for the smoke run',
      granted.status === 201 && (granted.data?.quota?.basic?.purchased ?? 0) >= 10,
      `status=${granted.status} purchased=${granted.data?.quota?.basic?.purchased}`,
    );
  }
```

要点：

- 现成的管理员会话就在文件里的「用户管理」段（`ADMIN_EMAIL` / `ADMIN_PASSWORD` 登录，CI 会给默认值），
  把它的 token 提上来复用即可（`adminToken`）；线上没配管理员时那一段本来就会 `skip`，
  这时赠额也跳过，并让后面的建表断言按原有方式失败（说明线上环境确实缺管理员凭据）。
- 「专业表格名额 +1」「12 个月 / 60 个月定价」「13 / 0 / 72 个月 → 400」「试用表格不单卖 → 400」
  这些断言**不需要改**：走支付时它们要么仍然 400（参数校验在订单接口之前），
  要么本来就是登录用户可调的下单接口（`count` / `months` 校验与支付无关）。
- 想连支付链路也冒烟，就在 CI 里加一个「本地假网关」作业：`node scripts/fake-xorpay.mjs` +
  `wrangler dev` + 一个只跑支付段的脚本（§8.3 的清单）。这是可选进阶，别塞进现有的线上冒烟。

### 8.3 建议新增的断言（假网关环境里跑）

| 断言 | 期望 |
| --- | --- |
| 匿名 `POST /api/quota/orders` | 401 |
| `kind: 'trial'` 下单 | 400（试用表格不单卖） |
| `count: 11` / `months: 13` / `months: 0` | 400 |
| 金额超上限（例：专业 10 个 × 60 个月 = ¥59,940） | 400 `order_amount_too_large`，**且配额不变** |
| 正常下单 | 202 + `pay.qr` + `order.status === 'pending'`，配额**不变** |
| `GET /api/quota/orders/:id`（别人账号的订单） | 404 |
| 伪造 `sign` 回调 | 400，订单仍 pending，配额不变 |
| 真签名但 `pay_price` 少 1 分 | 200，订单变 `amount_mismatch`，配额不变 |
| 正确回调一次 | 200，订单 `paid`、`table_purchases` 多一条、配额 +n |
| 同一回调再发 3 次 | 200，配额**只加一次**（`purchase_id` 不变） |
| 回调丢失，靠 `GET /api/quota/orders/:id` 兜底（假网关把订单标 paid、不发回调） | 查单后订单 `paid`、配额 +n |
| 订单过期（`expires_at` 过后查单） | `expired`，配额不变，可重新下单 |
| 未配置 XorPay（不设 secret）时下单 | 201 + `purchase` + 配额 +n（回归老行为） |

手工敲这些最省事的办法：假网关 + `curl`（`--data-urlencode` 带 `sign`），
或者给 `scripts/fake-xorpay.mjs` 加一个 `--scenario` 参数自动跑完一遍。

---

## 9. 上线步骤（照着做）

**第 1 步：代码落地**
按 §3 ~ §7 把文件改完，跑一遍全量本地校验（这 5 条都必须过）：

```bash
npm run typecheck      # 客户端 + Worker 两套 tsconfig
npm run build:client   # Vite 构建（客户端里引 shared/xorpay.ts）
npm run check:routes   # 新路由的方法 / 路径 / handler 自检
npm run check:scripts  # scripts/*.mjs 语法自检（含 fake-xorpay.mjs）
npm run schema:check   # 分片 schema 与迁移一致性
```

> 想让 `check:scripts` 也检查新脚本，记得把它加进 `package.json` 的 `check:scripts`
> （现在是 `node --check scripts/smoke-test.mjs && …`，追加 `&& node --check scripts/fake-xorpay.mjs`）。

**第 2 步：本地全链路（假网关）**

```bash
# 终端 A
node scripts/fake-xorpay.mjs
# 终端 B（先在 .dev.vars 里配好 XORPAY_AID / XORPAY_APP_SECRET / XORPAY_API_BASE）
npm run db:migrate:local
npm run dev
# 终端 C：模拟付款（订单号从界面上抄，或看终端 A 的日志）
curl.exe -X POST http://127.0.0.1:8788/__pay/<订单号>
```

界面上应当看到：下单 → 出现二维码 → 3 秒内二维码消失、名额 +n、弹出「支付成功」。

**第 3 步：本地回归（两种模式都要绿）**

```bash
# .dev.vars 里配了 XORPAY_*（第 2 步的状态），假网关开着
npm run test:e2e        # 290 项断言：走假网关下单（202 + 二维码）+ 管理员赠额兜底发名额
# 把 .dev.vars 里的 XORPAY_* 注释掉，重启 wrangler dev 再跑
npm run test:e2e        # 288 项断言：没配支付 ⇒ 购买仍是立即到账（老路径没坏）
```

> 两个数字都实测过：**288 = 未配支付**、**290 = 配了支付**（真实域名 `ADMIN_EMAIL` 时是 286，
> 目标上没有该管理员账号时整段 skip 是 263）。CI 的线上冒烟用同一套自适应逻辑，
> 所以线上配不配 XorPay 都不会因此变红。

**第 4 步：先部署「没有支付配置」的版本**
推一次代码，让 CI 走完部署 + 线上冒烟（此时 `XORPAY_*` 还没配 ⇒ 线上行为与现在完全一致）。
这一步的意义是：**先确认新代码本身没问题，再把收款打开**。

**第 5 步：开通 XorPay**
注册 → 填真实实名资料 → 交 ¥100 开通费 → 扫码签约（微信 / 支付宝任一即可，资料进件成功即算开通）
→ 微信会有机器人电话核对手机（按 1）。审核：微信几分钟、支付宝几小时。
在后台记下 **appid（aid）** 与 **app secret**。

**第 6 步：准备好回调域名**
绑一个自定义域到 Worker（`wrangler.jsonc` 的 `routes` 或控制台 Domains & Routes），
并设为 `PUBLIC_BASE_URL`。先手工验一下回调地址是通的：

```bash
# 期望：未配支付时返回 404 payment not configured（说明路由已被 Worker 接管，而不是被 SPA 兜底成 HTML）
curl.exe -i -X POST https://<你的域名>/api/xorpay/notify -H "content-type: application/x-www-form-urlencoded" -d "aoid=x"
```

> 返回 `content-type: text/plain` + 404 就对了；如果返回 HTML 说明 `run_worker_first` 没覆盖到这条路径
> （`wrangler.jsonc` 里是 `/api/*`，正常应该没问题）。

**第 7 步：配 secret 打开收款**

```bash
npx wrangler secret put XORPAY_AID
npx wrangler secret put XORPAY_APP_SECRET
# 可选：npx wrangler secret put PUBLIC_BASE_URL   /  只留一个通道时 put XORPAY_PAY_TYPES
```

或者在 GitHub 仓库 Secrets 里配同名的 `XORPAY_AID` / `XORPAY_APP_SECRET`，让 CI 自动同步
（`.github/workflows/deploy.yml` 的「同步可选 Secrets」步骤加两个变量即可，见下方片段）。
配完**重新部署一次**（secret 是写进 Worker 的，不需要改代码，但要让新实例生效）。

**第 8 步：真机小额验证**
用最低组合：基础表格 × 1 个 × 1 个月 = **¥9.90**（需要的话支付成功后到 XorPay 后台退款）。
验证四件事：① 二维码能扫、② 支付后名额到账（≤3 秒）、③ 同一个回调重发不会重复加名额、
④ `table_orders` 那一行有 `aoid` / `transaction_id` / `paid_at`。

**第 9 步：观察与对账（每天 / 每周跑一次）**

```sql
-- 最近 20 单
SELECT id, user_id, kind, count, months, amount_cents, paid_cents, status, pay_type,
       aoid, transaction_id, buyer, created_at, paid_at
  FROM table_orders ORDER BY created_at DESC LIMIT 20;

-- 需要人工处理：金额不符 / 已支付但没写出流水（自愈没跑到）
SELECT * FROM table_orders WHERE status = 'amount_mismatch';
SELECT * FROM table_orders WHERE status = 'paid' AND purchase_id = '';

-- 收款汇总（按天，单位：元）
SELECT date(created_at / 1000, 'unixepoch') AS day,
       SUM(CASE WHEN status = 'paid' THEN amount_cents ELSE 0 END) / 100.0 AS paid_yuan,
       COUNT(*) AS orders
  FROM table_orders GROUP BY day ORDER BY day DESC LIMIT 30;
```

**第 10 步：回滚（紧急关闭收款）**

```bash
npx wrangler secret delete XORPAY_AID
npx wrangler secret delete XORPAY_APP_SECRET
```

删掉 secret 后同一个接口立刻回到「自助直通」，购买又能白拿名额 —— **仅限紧急止血**，
记得同时把 `POST /api/quota/purchases` 关掉（临时把 `purchaseHandler` 改成直接 `throw forbidden(...)`），
否则等于把名额白送。表结构不用回滚（新表 / 新列对旧代码无影响）。

**CI 自动同步 secret（可选但推荐）**：`.github/workflows/deploy.yml` 里那段
「同步可选 Secrets」加两行即可（沿用现有的 `put()`：仓库没配就跳过，不影响其它部署）：

```yaml
      - name: 同步可选 Secrets（邮件 / 管理员 / 测试域回显白名单）到 Worker
        if: steps.creds.outputs.ready == 'true'
        env:
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
          # …（原有变量不动）
          AUTH_ECHO_CODE_DOMAINS: ${{ secrets.AUTH_ECHO_CODE_DOMAINS }}
          # 新增：XorPay 收款。仓库里没配就跳过 —— 线上继续保持「自助直通」，行为不变
          XORPAY_AID: ${{ secrets.XORPAY_AID }}
          XORPAY_APP_SECRET: ${{ secrets.XORPAY_APP_SECRET }}
        run: |
          set -uo pipefail
          # …（put() 函数与原有调用不动）
          put AUTH_ECHO_CODE_DOMAINS "${AUTH_ECHO_CODE_DOMAINS:-}"
          put XORPAY_AID "${XORPAY_AID:-}"
          put XORPAY_APP_SECRET "${XORPAY_APP_SECRET:-}"
```

---

## 10. 风险、排查与验收

### 10.1 风险表（按严重度排序）

| 风险 | 影响 | 对策（本方案里的位置） |
| --- | --- | --- |
| **回调打不到 Worker**（`*.workers.dev` 在国内不稳 / 没绑域名 / 域名解析错） | 用户付了钱名额不到账，靠查单兜底也救不回来（Worker 主动出网通常没问题，但用户可能立刻关页面） | §4 绑自定义域 + `PUBLIC_BASE_URL`；§5 前端 3 秒轮询 + §6.3 主动查单兜底；§9 第 6 步先验直达性 |
| **单笔金额超渠道限额**（支付宝当面付个人 ¥1000；本仓库最高 ¥59,940） | 下单成功但支付失败，体验差 | §2.4 决策 2 + `MAX_ORDER_AMOUNT_CENTS`，下单前 400 + 前端提示拆单 |
| **重复交付**（XorPay 会重试 6 次；前端轮询与回调并发） | 同一个订单加两次名额 | §6.3 `UPDATE … WHERE status <> 'paid'` 状态守卫 + `table_purchases.order_id` 部分唯一索引 + `INSERT OR IGNORE` |
| **金额被篡改 / 少付** | 白拿名额 | §6.3 `deliverFromNotify` 核对 `pay_price` 与订单金额，不符标记 `amount_mismatch` 不交付 + 日志 |
| **callback 伪造** | 白拿名额 | §6.4 验签（没配 secret 时回调直接 404；签名不对 400） |
| **支付挂掉 / 被风控**（`wechat_api_error` / `alipay_api_error` / `fee_error`） | 用户付不了钱 | §6.2 错误码翻中文给用户；`fee_error` 提醒给 XorPay 余额充值；风控按 `risk.html` 的申诉流程处理 |
| **`aoid` 与订单对不上**（换过数据库 / 手工测试） | 无法对账 | §6.4 未知订单回 200 停止重试 + `console.error`，靠 §9 对账 SQL 人工处理 |
| **secret 泄漏**（写进前端 / 提交进仓库） | 别人能伪造回调、冒用下单 | 只放 Worker secret / `.dev.vars`（已在 `.gitignore`）；`.dev.vars.example` 只留空值 |
| **退款** | 用户退款后名额还在 | 一期**不做自动退款**（`refund.html` 是后台手工发起）：退款后由管理员用 §6.6 的赠额接口做负数？——**没有负数赠额**，所以退款要走「人工把该用户的表格归档 / 客服沟通」。真要自动化，二期再加 `refunded` 状态与「扣回名额」逻辑（要处理「名额已经用来建表」的情况） |
| **合规** | 账号被风控 / 冻结 | 商品页醒目位置留客服联系方式（`risk.html` 的建议）；不接违规业务；保留订单表作为交易凭证 |

### 10.2 排查手册（症状 → 原因 → 处置）

| 症状 | 原因 | 处置 |
| --- | --- | --- |
| 下单报「签名错误」（`sign_error`） | `XORPAY_APP_SECRET` 不对（或前后有空格 / 换行） | `wrangler secret put` 重填；本地看 `.dev.vars`（代码里已 `.trim()`） |
| 下单报「aid 不存在」（`aid_not_exist`） | `XORPAY_AID` 填错 / 用了别的账户的 | 后台「应用配置」里复制 appid |
| 下单报「微信侧异常 / 支付宝侧异常」 | 账号被风控、或支付宝还没完成签约（`alipay_api_error` 且 info 是 `ACQ.ACCESS_FORBIDDEN` → 去邮件里点签约） | 按 `risk.html` 申诉；支付宝重新点签约 |
| 「XorPay 账号余额不足」（`fee_error`） | 平台手续费是从 XorPay 余额扣的 | 去 XorPay 后台充值 |
| 支付成功但名额没到 | ① 回调没打到（域名 / 防火墙 / WAF 拦 POST）；② 验签失败；③ 金额不符 | 先看 `table_orders` 那一行的 `status`；再看 XorPay 后台的通知记录；然后 `GET /api/quota/orders/:id` 手工触发一次查单；Worker 日志里 `[xorpay]` 开头的行能直接定位 |
| XorPay 后台显示「通知失败」反复重试 | 我们回的**不是 200**（验签失败 400 / content-type 不对 400 / 500） | `wrangler tail` 看日志；确认 `notify_url` 指向的是 Worker 而不是被 SPA 兜底的 HTML；确认没开「拦截 POST 的 WAF 规则」 |
| 订单 `amount_mismatch` | 实付与订单金额不一致（改价 / 人工测试） | 到 XorPay 后台核对金额，用 §6.6 赠额接口补偿正确的名额，再把该订单手工改成 `paid`（或留着做审计） |
| 界面上二维码图片裂了 | `xorpay.com/qr` 在用户网络里被阻断 | 一期先让用户「复制二维码内容」；二期可引入本地二维码库（`qrcode`）在浏览器里画（会新增一个前端依赖，需要评估） |
| 用户连点「去支付」生成多张订单 | 每次点击都新建订单（老单 120 分钟后过期） | 可接受（订单只是记录，不付款不产生名额）；要更严格就按「同一用户 + 同参数 + 最近 5 分钟内的 pending 单」复用 |

> **CI 里「线上冒烟测试」红了怎么定位**（`deploy.yml`）：线上冒烟的完整日志留在 `/tmp/smoke-online.log`，
> 失败时工作流会把**第一条 `FAIL` 行**写进 `deploy/cloudflare-workers` 这条 commit status 的
> `description`（140 字符内），所以不登网页也能读：
>
> ```bash
> curl -s "https://api.github.com/repos/<owner>/<repo>/commits/<sha>/statuses" | grep description
> ```
>
> 同时新增的一步「线上冒烟失败时输出失败断言」会把日志最后 40 行 + `FAIL` 行打到 `::error` 注解与 job 日志里。
> 注意：`the target runs the freshly deployed build` 这条红**通常只是新版本还没在边缘传播完**
> （`wrangler deploy` 返回 ≠ 所有边缘实例都换了新代码），等 30 ~ 90 秒重跑即可，不是业务代码问题 ——
> 实测遇到过一次：应用代码、迁移、部署全绿，仅该断言与随后的时序敏感断言红了，重跑即绿。

### 10.3 验收清单

- [ ] `npm run typecheck` / `build:client` / `check:routes` / `check:scripts` / `schema:check` 全绿
- [ ] 本地假网关：下单 → 二维码 → 模拟付款 → 名额到账（≤3 秒）
- [ ] 本地未配支付：`npm run test:e2e` **288** 项断言全绿（老行为没坏）
- [ ] 本地配假网关（`XORPAY_AID` / `XORPAY_APP_SECRET` / `XORPAY_API_BASE`）：`npm run test:e2e` **290** 项断言全绿
      （多「下单要在线支付（202 + 二维码）」与「管理员赠额兜底」两条；2026-10 又新增「删表不退名额 / 续费 / 登录页副标题」7 条、
      「附件生命周期 / 满容量不许加视图 / 到期状态下发」10 条，两种模式都已实测全绿）
- [ ] 续费全链路（假网关）：建表 → 清单里点「续费」下单（202 + 二维码，订单带 `databaseId`）
      → `curl.exe -X POST http://127.0.0.1:8788/__pay/<订单号>` → 订单 `paid`、表格 `slotExpiresAt` 往后推一个月、
      `basic.remaining` 与 `purchased` 都不变
- [ ] 伪造 `sign` 的回调被拒（400），订单仍 pending
- [ ] 同一回调重发 3 次，名额只加一次
- [ ] 少付 1 分：订单 `amount_mismatch`，名额不加
- [ ] 回调丢失时，前端轮询能把名额补上
- [ ] 回调地址公网可达、返回 `text/plain`（不是 HTML）
- [ ] 真机 ¥9.90 支付：`table_orders` 有 `aoid` / `transaction_id` / `paid_at`，XorPay 后台能查到同一笔
- [ ] 文档同步：README / DEPLOY / docs/storage.md 里「支付尚未接入」的句子已全部改掉
      （README 的「表格名额」行、`src/shared/types.ts` 里 `TablePurchase` 的注释、
      `migrations/control/0011` 与 `0015` 的历史说明可以保留原文，但要在新迁移 0016 里说明演进）

### 10.4 表格续费：复用同一套下单 / 支付（2026-10 新增）

基础 / 专业表格现在各自带一段「时长」（建表时按该类型最近一次购买的时长起算，
存在用户库的 `table_slot_allocations.expires_at`，计算与校验见 `src/worker/slots.ts`）。
剩余不到一周（`SLOT_RENEW_WINDOW_DAYS = 7`）时，表格清单里这张表后面会出现「续费」，
点开的就是同一个「表格数量说明」弹窗（切到续费模式：类型 / 数量锁死），
下单仍然走 `POST /api/quota/orders`，只是多带一个 `databaseId`：

| 环节 | 复用点 | 续费的差别 |
| --- | --- | --- |
| 下单 | `createOrderForUser()`（同一个函数） | 先 `resolveRenewTarget()` 校验表格归属与类型（不存在 404、类型对不上 400、`count` 必须为 1）；订单多写一列 `database_id` |
| 价格 | `purchaseAmountCents(kind, 1, months)` | 完全相同：基础 9.9 元/月、专业 99.9 元/月，月 / 年单位与数量范围也一致 |
| 支付 | 同一条 XorPay 下单 + 回调 / 查单兜底 | 商品名写成「基础表格续费 × 1（1 个月）」，微信账单上一眼能看出是续费 |
| 交付 | `deliverOrder()`（幂等状态守卫与流水写入都不变） | 流水带 `database_id`（`GET /api/quota` 的「已购买」会跳过它），再调 `renewSlot()` 把 `expires_at` 从 `max(now, 原到期时间)` 往后推 |
| 名额 | — | **不增加**可添加的表格名额：买的是这张表的时间，不是新名额 |

没开通收款（本地 / CI）时同样是「下单即到账」：自助直通分支写完流水就顺手 `renewSlot()`，
两种模式下续费的行为一致。表结构见 `migrations/control/0017_slot_renewals.sql`。

> 迁移之前建的老表格没有 `table_slot_allocations` 行：列表里按**该类型最近一笔购买的到期时间**
> 兜底（`latestPurchaseExpiry()`），所以它们进入最后一周时同样会显示「续费」；
> 真正下这一单时 `resolveRenewTarget()` 会现场补一条时长记录，之后的续费就走 `expires_at` 了。

> 同一次改动也把「删表与名额」的关系定死了：**基础 / 专业表格被删掉后名额不退还**
> （`table_slot_consumptions` 记一笔，`GET /api/quota` 的「已用」把它算进去，已付的钱也不退），
> 试用表格保持原样（删掉就把名额还回来）。

---

## 11. 落地顺序（按文件，一步一验）

| 顺序 | 文件 | 做完立刻验证 |
| --- | --- | --- |
| 1 | `migrations/control/0016_table_orders.sql` | `npm run db:migrate:local` 成功；`npm run schema:check` 通过 |
| 2 | `src/worker/md5.ts` | 写个临时脚本对 RFC 1321 标准向量（`md5("")` = `d41d8cd9…`） |
| 3 | `src/shared/xorpay.ts` + `src/shared/types.ts`（`TableOrder`） | `npm run typecheck` |
| 4 | `src/worker/types.ts`（Env 5 个字段）+ `src/worker/xorpay.ts` | `npm run typecheck` |
| 5 | `src/worker/orders.ts` | `npm run typecheck` |
| 6 | `src/worker/routes/payments.ts` + `routes/quota.ts`（改 `purchaseHandler`）+ `routes/admin.ts`（赠额）+ `index.ts` 注册 | `npm run typecheck` + `npm run check:routes`（应看到 4 条新路由） |
| 7 | `src/client/api.ts` → `Sidebar.tsx` → `App.tsx` → `styles.css` | `npm run build:client`（构建产物里应包含 `quota-pay` 与 `xorpay.com/qr`） |
| 8 | `scripts/fake-xorpay.mjs`（+ `package.json` 的 `check:scripts` 追加一条） | `node --check scripts/fake-xorpay.mjs`；本地全链路走通 |
| 9 | `scripts/smoke-test.mjs`（bootstrap 名额段加 201/202 分支） | `npm run test:e2e` |
| 10 | 文案与配置：`README.md` / `DEPLOY.md` / `docs/storage.md` / `.dev.vars.example` / `wrangler.jsonc` 注释 / `.github/workflows/deploy.yml`（`docs/storage.md` 的「用户库」那一列要加上「支付订单（`table_orders`）」） | `npm run test:e2e` + 提交推送看 CI |

> 这份文档本身就是第 10 步要加进索引的文件：建议在 `README.md` 的「文档」一节
> （和 `docs/storage.md` 并列）加一行 `docs/payment-xorpay.md  用 XorPay 接入表格名额购买`，
> 并在 `DEPLOY.md` 的「6.6 邮件与超级管理员」后面加一节「6.8 收款（XorPay）」指回本文。

---

## 附：本文代码片段的验证情况

- 抽出来的 **16 个完整文件块**（`src/shared/xorpay.ts`、`src/worker/md5.ts`、`src/worker/xorpay.ts`、
  `src/worker/orders.ts`（4 块）、`src/worker/routes/payments.ts` 等）已写进临时目录，用
  `npx tsc --noEmit --noCheck --ignoreConfig --jsx react-jsx --target esnext --module esnext
  --moduleResolution bundler` 做过**语法解析**检查：零错误。
- `src/worker/md5.ts` 已对 RFC 1321 标准向量逐一比对通过
  （`md5("")` = `d41d8cd98f00b204e9800998ecf8427e`、`md5("abc")` = `900150983cd24fb0d6963f7d28e17f72`、
  `"message digest"`、26 字母、80 位数字串），并与 `node:crypto` 的 `createHash('md5')`
  对 **300 条随机 UTF-8 字符串**结果完全一致。
- 另有 6 个块是「往现有文件里插几行」的**局部片段**（`Env` 字段、`adminRoutes` 的单条路由、
  `api` 对象里的两个方法、QuotaDialog 的 JSX 与 props、`<Sidebar>` 的 props）——
  它们本身不是可独立解析的完整文件，按注释位置插入即可。
- 全部 XorPay 字段名 / 签名顺序 / 回调参数 / 状态码取自官方文档 <https://xorpay.com/doc/>
  的 `api.html` / `sign.html` / `native.html` / `alipay.html` / `notify.html` / `query.html` / `qr.html`
  / `faq.html` / `risk.html`；文档若改版，以官方为准。














