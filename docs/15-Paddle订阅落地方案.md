# Paddle 订阅落地方案

> 2026-11。本文是支付部分的唯一执行文档，`docs/14-支付与订阅接入方案.md` 里的支付宝/微信直连方案暂时搁置（保留作后续自建通道的参考）。

## 一、结论先行

| 问题 | 答案 |
|---|---|
| 国内用户能用支付宝吗 | **能**，但必须满足三个条件：商品以 **CNY 定价**、客户账单地址为 **中国**、通过 Paddle **审批**（Typeform 申请，非自动开通） |
| 国外支付宝也一样吗 | 支付宝（Paddle 里叫 Alipay）只对中国地址展示，海外用户看不到这一项；海外走卡/PayPal/Apple Pay/Google Pay |
| 国外主流支付方式支持吗 | 支持 18 种：卡、Apple Pay、Google Pay、PayPal、iDEAL\|Wero、Bancontact、BLIK、MB WAY、Pix、UPI、KakaoPay、Naver Pay、Payco、Samsung Pay、韩国本地卡、银行转账、Alipay、WeChat Pay |
| 微信支付能用吗 | **订阅场景不能**：Paddle 的 WeChat Pay 仅支持一次性商品（`Subscriptions: Not supported`），且仅桌面端扫码 |
| 自动续费麻烦吗 | 不麻烦，订阅是 Paddle 的一等公民；但会**收窄支付方式**（见 3.3） |

一句话：**订阅 + 自动续费是主路径**，用卡/钱包/支付宝；微信支付、Pix、iDEAL 这类一次性本地方式只能用于买断，暂不支持。

## 二、定价

Pro 提供两种买法，**权益完全相同**，差别只在「会不会自动扣款」：

| 档位 | 自动续费（订阅 price） | 一次性（one-time price） | 说明 |
|---|---|---|---|
| 月付 | **$20 / 月** · ¥149 | **$23** / 30 天 · ¥169 | 订阅随时取消；一次性到期不扣款 |
| 年付 | **$160 / 年**（标准价 $240）· ¥1,099 | **$180** / 365 天 · ¥1,299 | 早期用户价；一次性能覆盖微信支付等本地方式 |

用户为什么愿意多付 3 美元买一次性：不想绑卡、不想记着取消、所在地区只支持一次性支付方式（微信支付 / Pix / iDEAL / BLIK / UPI 等）。这也是自动续费收窄支付方式的解法（见 3.3）。

约束与理由：

- **支付宝单笔上限 1,600 CNY**（折扣前金额同样受限）。订阅年付必须留在 1,600 以内，¥1,099 合规；一次性年付 ¥1,299 也在上限内，但**支付宝一次性交易**若要支持需确认 Paddle 侧 `Alipay` 是否对 one-time 定价商品开放（当前文档只写了订阅续费上限），上线前用 sandbox 实测一次。
- 一次性价格**必须是非循环 price**，否则 Paddle 会把它当订阅，用户会被静默订阅。
- 早期价用「直接建低价 price」实现，不用 Paddle discount。将来涨价时**新建** price，老订阅继续用旧 price 续费，天然不影响存量用户。
- 币种由服务端按 `CF-IPCountry` 选择：中国 → CNY price，其余 → USD price。Paddle 的结算页再按账单地址展示本地币种与税费。
- 税务由 Paddle 作为 Merchant of Record 处理，价格标价不含税，结算页按地址加税。

## 三、订阅方案

### 3.1 状态映射

Paddle 订阅状态 → 我们是否给权益：

| Paddle status | 含义 | 是否算 Pro | `users.pro_until` |
|---|---|---|---|
| `active` | 正常 | 是 | `current_billing_period.ends_at` |
| `trialing` | 试用中 | 是 | 同上 |
| `past_due` | 扣款失败，Paddle 正在重试 | 是（宽限） | 保持不变 |
| `paused` | 暂停 | 否 | 保持不变 |
| `canceled` | 已终止 | 否 | 保留到期末，不缩短 |

判定只看一个字段：`users.pro_until > now`。前端、权限中间件、导出接口都读它，不各自解释订阅状态。

### 3.2 用户可见的生命周期

1. 点开通 → 服务端建交易 → 跳 Paddle 托管结算页 → 付款成功回到 `/account`
2. 回到账户页先 `POST /api/billing/sync` 主动拉一次，再短轮询 `/api/billing/me`（2.5s × 24 次），覆盖 webhook 延迟
3. 平时：账户页显示「下次自动扣款：YYYY-MM-DD（$20）」
4. 取消：`POST /api/billing/cancel` → Paddle 在**周期末**取消，当期权益保留，页面显示「已取消自动续费，权益保留至 …」
5. 反悔：`POST /api/billing/resume` → `PATCH /subscriptions/{id}` 把 `scheduled_change` 置 null，恢复续费
6. 续费：Paddle 自动扣款，webhook 更新 `current_period_end` 并新增一条订单记录

### 3.3 自动续费对支付方式的收窄（重要）

Paddle 只会对**订阅交易**展示支持重复扣款的方式：

- 明确支持订阅：信用卡/借记卡、Apple Pay、Google Pay、支付宝（CNY，有 1,600 上限）
- 一次性本地方式（WeChat Pay、Pix、iDEAL、BLIK、MB WAY、UPI、KakaoPay 等）在订阅结账时不会出现

**已实现**：一次性买断就是这条解法。`POST /api/billing/checkout` 接受 `autoRenew: false`，改用 one-time price 建交易；webhook 里 `transaction` 没有 `subscription_id` → 走 `grantOneTime`，按 `pro_until = max(now, pro_until) + 30/365 天` 加时长，并用 `orders.granted_at IS NULL` 兜底幂等（D1 batch 原子提交）。

这样一来：想在巴西用 Pix、在荷兰用 iDEAL、在国内用微信支付，就走一次性；想用卡/支付宝订阅省钱，就走自动续费。前端在定价页与账户页把两个按钮并排摆出来，由用户选。

## 四、数据模型

`apps/api/migrations/0004_paddle_subscriptions.sql`

- `subscriptions`：一个用户一条（`user_id` 唯一），字段包括 `status`、`price_id`、`plan`、`currency`、`amount_cents`、`current_period_end`、`next_billed_at`、`cancel_at_period_end`、`canceled_at`、`raw`
- `orders.subscription_id`：每期续费也记一笔，便于对账
- `users.pro_until`、`users.paddle_customer_id`：沿用 0003，`pro_until` 是权益缓存

幂等与乱序：`subscriptions.id` 是 Paddle 订阅 ID，重复投递只覆盖同值；`updated_at` 比库里旧的事件直接丢弃，避免「取消后又被旧事件复活」。

## 五、API（`apps/api/src/routes/billing.ts`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/billing/me` | 订阅状态、Pro 到期、币种、最近 20 笔订单 |
| POST | `/api/billing/checkout` | 入参 `{ plan: "month" \| "year" }`，按 IP 选币种，返回 `checkoutUrl`；已有生效订阅返回 409 |
| POST | `/api/billing/sync` | 入参 `{ transactionId }`，回跳兜底，校验 `custom_data.user_id` 与当前用户一致 |
| POST | `/api/billing/cancel` | 周期末取消 |
| POST | `/api/billing/resume` | 撤销周期末取消 |
| POST | `/api/billing/webhook` | `Paddle-Signature` 验签（HMAC-SHA256 over `ts:body`，5s 容差） |

webhook 处理：`subscription.*` 统一镜像落库；`transaction.completed|paid` 记订单并回拉订阅；`adjustment.created`（refund）把订单标记为 `refunded`，**不自动收回权益**（避免误伤正在使用的用户，人工判断）。

## 六、配置

```bash
cd apps/api
npx wrangler secret put PADDLE_API_KEY           # pdl_sdbx_apikey_... / pdl_live_apikey_...
npx wrangler secret put PADDLE_WEBHOOK_SECRET    # pdl_ntfset_...
npx wrangler secret put PADDLE_PRICE_MONTH_USD   # pri_...
npx wrangler secret put PADDLE_PRICE_YEAR_USD
npx wrangler secret put PADDLE_PRICE_MONTH_CNY   # 可选，配了才有支付宝
npx wrangler secret put PADDLE_PRICE_YEAR_CNY
# 一次性（不续费）价格，可选；不配则页面上的「一次性」按钮自动置灰
npx wrangler secret put PADDLE_PRICE_MONTH_ONCE_USD
npx wrangler secret put PADDLE_PRICE_YEAR_ONCE_USD
npx wrangler secret put PADDLE_PRICE_MONTH_ONCE_CNY
npx wrangler secret put PADDLE_PRICE_YEAR_ONCE_CNY
npx wrangler d1 migrations apply horizons-db --remote
```

`PADDLE_ENV` 在 `apps/api/wrangler.jsonc` 的 `vars` 里，默认 `sandbox`；切正式改成 `production` 再发版。

## 七、Paddle 后台待办（按顺序）

1. **Catalog**：建 1 个 Product（Pro），4 个 **recurring** Price + 4 个 **one-time** Price：
   - recurring：$20 / month、$160 / year（USD）；¥149 / month、¥1,099 / year（CNY）
   - one-time：$23（30 天）、$180（365 天）（USD）；¥169、¥1,299（CNY）
   - one-time 的 Price 在 Paddle 后台选 `Billing type = One-time`，**不要**选 `Standard`（Standard 会当订阅处理）
2. **Checkout → Checkout configuration → Payment methods**：勾选 Card、PayPal、Apple Pay、Google Pay；支付宝要等审批通过后再勾
3. **支付宝审批**：提交 Paddle 的 `Request approval for Alipay` 表单（条件：CNY 定价 + 订阅续费 ≤ 1,600 CNY + 不在支付宝禁售清单）。审批通过后才会在后台出现可勾选项
4. **Developer Tools → Notifications**：目标 `https://horizons.tools/api/billing/webhook`，勾选 `subscription.created`、`subscription.updated`、`subscription.canceled`、`subscription.past_due`、`transaction.completed`、`transaction.paid`、`adjustment.created`
5. **Checkout → Default payment link**：`https://horizons.tools/account`；并把 `horizons.tools` 加进已批准域名（否则接口返回的 `checkout.url` 为空）
6. 如启用支付宝：确认 CNY 结算的收款与换汇设置

## 八、验收

- sandbox 测试卡 `4242 4242 4242 4242` 走完订阅：账户页显示「自动续费中」+ 下次扣款日
- 账户页取消 → 显示「已取消，权益保留至 …」→ 恢复 → 回到「自动续费中」
- 后台 Resend 同一 `subscription.updated` 事件：不重复、不来回翻状态（`updated_at` 保护）
- 同一 `transaction.completed` 投递两次：`orders` 只有一条
- 中国 IP + CNY price：结算页出现支付宝（需先审批）
- webhook 目标临时改错 → 付款后回到账户页仍能通过 `/sync` 开通
- 一次性买断（`autoRenew: false`）：`pro_until` 从当前值 +30/365 天；同一 `transaction.completed` 投两次只加一次
- 已是 Pro 用一次性续期：到期日在原值上叠加，不会被覆盖成「从现在起算」
- 未配 `PADDLE_PRICE_*_ONCE_*` 时：定价页仍显示一次性价格，但账户页的一次性按钮置灰（`oneTimeAvailable=false`）

## 九、边界与待办

- **微信支付不支持订阅**，国内用户实际是「支付宝 / 卡 / PayPal」，如需微信只能买断
- 支付宝有 `1,600 CNY` 上限与拒付不支持（`Chargebacks: Not supported`）的属性，风控上注意
- 退款不自动降级；如需强制停用，人工把 `users.pro_until` 置为当前时间并把订阅在 Paddle 取消
- 尚未接入 Paddle customer portal（改卡、改邮箱、下载发票）；需要时加 `POST /api/billing/portal` 生成 portal 会话
- 订阅发票与收据由 Paddle 自动邮件发送，支持企业抬头在 Paddle 结算页填写