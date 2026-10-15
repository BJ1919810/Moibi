# 墨笔 · 数据 Schema v2

> 对应实现：`server/schema.js`（定义与 ID 生成）、`server/migrate.js`（v1→v2 迁移 + v2-R1 补丁）、`server/ledger.js`（账本读写与筛选）、`server/projection.js`（唯一投影出口）、`server/store.js`（持久化与结构校验）、`server/auth.js`（访问控制）。
>
> 一句话概括结构变化：**实体与名字解耦、状态账本拆四类、存储与上下文分离、可信度与时间成为硬约束**。
>
> 版本演进：
> - **v2.0**：实体表、四类账本、统一投影、章节数参数化。
> - **v2.1（R1）**：`trust` 可信度三态、事件身份 ID、时间边界、空 cast 三态、投影诊断、同源校验、`validateProject` 进入业务路径。
>   本节所有「标记」都不是装饰字段，**每一条都有明确的运行行为** —— 见第八节对照表。
>
> ⚠️ **两处自述已经过期（尚未回填）**：
> 1. §14.6 写「用户确认、乐观并发、写锁、幂等重放属 R4，本阶段不启用」——**已实现**：`server/workflow.js` 的 `commitDraft`（纯函数）+ `headVersion`/`editRevision` CAS + 幂等键。
> 2. §九 写「5a 的完整修复需要 P1 的 L2 规划器」——**已交付**：`server/chapter-planner.js`（确定性轻量 L2）与 `dynamic-plan.js`。
> 另：顶层的 `state` 字段已 `deprecated`，只作兼容层保留。
> 权威的「现在是什么状态」请看 `.workbuddy/memory/MEMORY.md` 与 `.skills/*.md`。

---

## 一、顶层结构

```jsonc
{
  "id": "p_64d57c208eb4",
  "schemaVersion": 2,          // ← 迁移判据，>= 2 即不再走 v1→v2 流程
  "headVersion": 2,            // 提交计数，每写完一章 +1（P0-2 将参与版本校验）
  "createdAt": "...", "updatedAt": "...",

  "title": "十年雨信",
  "idea": "主角在雨夜收到一封来自十年后的信",
  "genre": "悬疑",
  "targetChapters": 34,        // ← 章节规模由用户决定（不再是硬编码 24-40）

  "entities": [ /* 见二 */ ],
  "outline":  { /* 见三 */ },
  "ledger":   { /* 见四 */ },
  "chapters": [ /* 见五 */ ],
  "state":    { "deprecated": true, ... },   // 兼容层，待账本切换完成后移除
  "migrations": [ { "from": 1, "to": 2, "at": "...", "notes": ["..."] },
                  { "patch": "v2-r1", "at": "...", "notes": ["..."] } ],
  "lastValidation": { "at": "...", "ok": true, "count": 0, "issues": [] },
  "usage": { "calls": 5, "inputTokens": 7233, "outputTokens": 13443, "reasoningTokens": 4447 }
}
```

`lastValidation` 由 `store.saveProject()` 在每次写盘前填充（`validateProject` 的结果摘要）。
默认不阻断写入 —— 旧数据可能暂时不合规，不应因一次校验失败丢用户作品；迁移等关键路径传 `{ strict: true }` 会直接抛错。

---

## 二、`entities` —— 实体表

角色、地点、物品都有稳定 ID，**全文靠 ID 关联，不再靠名字**。
这是「改名不失效」的前提，也是后续人物关系、角色认知、伏笔关联的基础。

```jsonc
{
  "id": "ent_ad8bc132ed",      // 由 kind + name 派生，改名不变
  "kind": "character",          // character | place | item
  "name": "顾行舟",             // 当前显示名，可修改
  "aliases": [],                // 改名后旧名进这里，历史正文仍可检索

  "publicRole": "档案馆志愿者",  // ↓ 这两项**可以**进正文
  "publicIdentity": "26岁，修复手艺极好，两个月前来到档案馆",

  "authorRole": "对手",          // ↓ 以下**永不**进正文
  "secret": "实为十年前死者林晚之子，筹划此局十年",
  "want": "逼沈砚亲手揭开真相",
  "fear": "怕母亲被彻底忘记",

  "migrationNote": null,        // 迁移补注（旧 identity 整体归入 secret 等）
  "createdAt": "...", "updatedAt": "..."
}
```

**ID 派生规则**：`ent_` + `SHA1("character:顾行舟")[0..10]`。
同一输入必然得到同一 ID ⇒ 迁移可重复执行而不产生重复实体。

---

## 三、`outline`

```jsonc
{
  "logline": "...", "theme": "...", "style": "...",
  "acts": [ { "name": "第一幕", "summary": "...", "function": "..." } ],

  "cast": [ { "name": "沈砚", "entityId": "ent_d858ac3412" } ],   // ← 引用实体

  "foreshadows": [
    {
      "id": "fs_9c1e...",        // ← 稳定 ID（v2-R1 起必有值，空串会被校验拦下）
      "seed": "信封上的邮戳来自一九九八年就已撤销的城南邮局",      // 可进正文
      "payoff": "信并非邮寄，而是有人亲手投入信箱……",              // 永不进正文
      "plantAt": 10, "revealAt": 26,        // 新作品由大纲直接产出
      "plantChapter": null,                 // 旧作品的铺设章（模型辅助迁移后填）
      "payoffChapter": null,                // 旧作品的回收章
      "linkStatus": "needsReview",          // explicit | needsReview
      "entityIds": ["ent_ad8bc132ed"]
    }
  ],

  "volumes": [
    {
      "title": "卷一 雨夜来信", "goal": "...",
      "chapters": [
        {
          "no": 3,
          "title": "笔迹吻合度",
          "summary": "...", "goal": "...",
          "cast": ["ent_d858ac3412"],           // ← 本章出场白名单（实体 ID）
          "castSource": "from-outline",          // from-outline | inferred-from-summary
          "foreshadows": [ { "id": "fs_9c1e...", "action": "plant" } ]
        }
      ]
    }
  ],
  "totalChapters": 34
}
```

**`cast` 是防「未授权角色提前出场」的硬约束**：未列入的角色不得在该章正式出场。
主角始终自动纳入（否则正文无从下笔）。三种 `cast` 状态的含义见第十节。

**`castSource`** 区分名单来源：
`from-outline` = 大纲生成时明确给出；`inferred-from-summary` = 旧数据迁移时从 `summary`/`goal`
按「出现过的角色名」确定性推断（可能不全，属于待补全状态）。

**`linkStatus`** 区分伏笔关联的可信度：`explicit` = 有明确章号；`needsReview` = 旧数据无章号，
需模型辅助迁移后转 `explicit`。R1 阶段**只分配 ID，不假装已经关联**。

---

## 四、`ledger` —— 状态账本

取代 v1 的 `state.facts[]` / `state.threads[]` 两个字符串数组。
**存储层永不截断**；挑选发生在上下文层（`ledger.selectContext`）。

账本共 **五张表**：`canonicalFacts` / `currentState` / `characterKnowledge` /
`plotThreads` / **`stateEvents`（R2 新增，只增不改的事件日志）**。

四类**内容表**条目的公共字段（v2.1 新增后三项）：

| 字段 | 取值 | 含义与运行行为 |
|---|---|---|
| `visibility` | `public` / `secret` | `secret` 一律剔除，不进正文上下文 |
| `status` | `active` / `superseded`（事实、状态）/ `open`…`paid_off`（线索） | 非 `active` 的旧状态保留但不再作为「当前」 |
| `trust` | `canonical` / `legacy_unverified` / `needsReview` | **见第八节**，决定是否进入正文上下文 |
| `storyTime` | number / null | 叙事时间线位置，MVP 未填充，接口预留（见第九节） |

R2 起，四类内容表条目还带**出处四件套**（由状态引擎写回，见 4.5 与第六节）：

| 字段 | 含义 |
|---|---|
| `sourceChapter` | 出处章号（记录出自哪一章的正文） |
| `sourceVersion` | 出处**正文版本** = 提交后的 `headVersion`（R4 会用乐观并发计数替换为正式值） |
| `sourceSpan` | 正文内的具体位置（段落/字符区间），预留，反向提取完成后填 |
| `eventId` | 产生本条记录的那次转移事件（指向 `stateEvents[].id`） |

### 4.1 `canonicalFacts` —— 已确立的稳定事实

```jsonc
{
  "id": "fact_9f2c1a0b3d",
  "text": "沈砚十年前有三天记忆空白",
  "entityIds": ["ent_d858ac3412"],
  "sourceChapter": 1,           // 出处章号；迁移来的旧记录为 null
  "sourceSpan": null,           // 段落级出处（预留）
  "visibility": "public",       // public | secret
  "verified": true,             // false = 待验证（迁移自旧数据的均为 false）
  "status": "active",           // active | superseded
  "trust": "canonical",         // ← v2.1：canonical | legacy_unverified | needsReview
  "storyTime": null,
  "createdAt": "..."
}
```

### 4.2 `currentState` —— 可逆但决定下一章能写什么

```jsonc
{
  "id": "st_b68c911a65",
  "subjectId": "ent_d858ac3412",
  "attribute": "所在",           // 所在 / 持有 / 伤势 / 关系
  "value": "档案馆",
  "sinceChapter": 3,             // 生效章：from 起有效
  "untilChapter": null,          // ← R2：失效章；被替代时写入（active 时为 null）
  "eventSeq": 0,                 // ← 同章内同主体同属性的多次变更，用序号区分
  "eventId": "ev_cd09e9b28f",    // ← R2：产生本条的那次转移事件
  "supersededBy": null,          // ← R2：被哪条记录替代（active 时为 null）
  "status": "active",            // active | superseded（失效不删除）
  "visibility": "public",
  "trust": "canonical",
  "sourceChapter": 3,
  "sourceVersion": 3,
  "sourceSpan": null,
  "storyTime": null
}
```

**生效区间语义（R2）**：`isEffectiveAt(rec, ch)` = `sinceChapter <= ch < untilChapter`
（`untilChapter` 为 null 表示仍生效）。所以「第 N 章他在哪」可回查，
而不必看「最新值」—— 见第九节的按章回查与下面 4.5 的事件日志。

> 这一类的存在本身就是对 v1 的纠正：v1 只记「不可逆事实」，把伤势、持有物、怀疑关系这类
> **可逆但构成下一章前提**的信息全部排除了。

### 4.3 `characterKnowledge` —— 谁知道 / 谁误信 / 谁怀疑

```jsonc
{
  "id": "kn_fa49b8edd7",
  "characterId": "ent_d858ac3412",
  "fact": "尾号零七档案与十年前的青江桥有关",
  "belief": "knows",             // knows | believes | suspects
  "sinceChapter": 8,
  "untilChapter": null,          // ← R2：认知升级时旧记录收尾
  "eventSeq": 0,                 // ← R2
  "eventId": "ev_b276fd7c38",    // ← R2
  "status": "active",
  "visibility": "public",
  "trust": "canonical",
  "sourceChapter": 8,
  "sourceVersion": 8,
  "sourceSpan": null,
  "storyTime": null
}
```

> **认知演变是一串记录，不是一个字段。** 对同一条事实，`suspects → believes → knows`
> 会留下三条记录（`(角色, 事实)` 为归并键，同一时刻只有一条 `active`）。
> 于是既能回答「第 6 章他知道多少」（按章回查，取到 `believes`），
> 又不会在上下文里让「他怀疑」和「他确信」同时出现。

### 4.4 `plotThreads` —— 伏笔与悬念的生命周期

```jsonc
{
  "id": "th_...",
  "text": "沈砚左手腕有一道不记得来源的旧疤",
  "foreshadowId": "fs_9c1e...",  // 关联大纲伏笔的稳定 ID（可为 null）
  "entityIds": ["ent_d858ac3412"],
  "status": "open",              // open | planted | reinforced | paid_off | abandoned
  "plantedAt": null,
  "reinforcedAt": [],            // 可多次强化，用事件记录而非单字段
  "paidOffAt": null,             // 回收后仍保留，供回查
  "sourceChapter": null,
  "visibility": "public",
  "trust": "canonical",
  "storyTime": null
}
```

### 4.5 `stateEvents` —— 状态转移事件日志（R2 新增）

四张内容表回答「**现在是什么**」，这张表回答「**曾经发生过什么**」。
**只增不改、永不删除**，是一条 append-only 的转移流水。

```jsonc
{
  "id": "ev_a1630d43d6",
  "kind": "state",               // state | knowledge
  "subjectId": "ent_d858ac3412", // knowledge 时为角色 ID
  "attribute": "所在",           // knowledge 时恒为 "belief"
  "fromValue": "档案馆",         // 上一次的取值；旧数据补事件时为 null（不伪造）
  "toValue": "青江桥",
  "fromStateId": "st_feb6caf5ca",  // 被替代的那条记录（无则 null）
  "toStateId": "st_dad94fc2f8",    // 新产生的那条记录
  "chapterNo": 3,                // 变化发生在哪一章
  "seq": 1,                      // 同章同 (主体|属性) 桶内的序号
  "idempotencyKey": "ik_440fb29f6e", // 这一次提交的防重键（见第六节）
  "batchKey": "ch3:cf_7be2f1a90c",   // 提交标识：章号 + 正文内容指纹
  "seqKey": "ent_d858ac3412|所在|3",
  "sourceChapter": 3,
  "sourceVersion": 3,
  "sourceSpan": null,            // 正文内位置，预留
  "trust": "canonical",
  "createdAt": "..."
}
```

> **为什么内容表不够，还要单独一张事件表**：内容表会被 `supersede` 改写状态字段，
> 是「可变视图」；而「谁在第几章把什么改成了什么」是**事实**，一旦写入就不该再变。
> 二者分开，才能既保证上下文只看到唯一当前值，又保留完整的可回溯历史。

---

## 五、`chapters`

```jsonc
{
  "no": 1,
  "title": "雨夜投递",
  "volumeTitle": "卷一 雨夜来信",
  "text": "（正文原文，一字不改）",
  "summary": "（本章摘要，供后续章节做前情）",
  "extracted": { /* 模型原始提取结果，便于排查 */ },
  "applied": { "facts": 5, "states": 2, "knowledge": 1, "threads": 7, "resolved": 0 },
  "extractOk": true,
  "wordCount": 2508,
  "status": "committed",         // committed | draft（P0-2 启用）
  "packetSchemaVersion": 2,      // 生成该章时用的投影版本
  "castStatus": "limited",       // ← v2.1：本次投影的出场名单状态（unknown/none/limited）
  "contextNotes": [],            // ← v2.1：本次投影做过的剔除/隔离/截断摘要
  "transition": {                // ← R2：本次落账的状态转移诊断
    "ok": true,
    "skipped": false,            // 因重复提交 / 无变化而整批跳过
    "rejected": false,           // 含 error 级非法转移 → 整批拒绝
    "batchKey": "ch3:cf_7be2f1a90c",
    "sourceVersion": 3,
    "events": 3,                 // 本次写入的事件数
    "superseded": 2,             // 本次收尾的旧记录数
    "violations": []             // { code, severity, index, message }[]
  },
  "createdAt": "..."
}
```

`contextNotes` 与 `castStatus` 是「诊断落到记录上」的产物 —— 生成时发生过隔离、剔除未来记录、
名单缺失等情况，事后可凭章节记录追查，而不只存在于当场日志里。
R2 的 `transition` 同理：这一章的状态转移到底生效了、跳过了、还是被整批拒绝，
写在该章记录上，而不是只留在当时的进程日志里（进程日志一次重跑就没了）。

---

## 六、ID 生成与去重规则

| 对象 | 规则 | 关键点 |
|---|---|---|
| 实体 | `ent_` + SHA1(`kind:name`) | 改名后 ID 不变 |
| 事实 | `fact_` + SHA1(归一化正文) | 同义写法不产生两条记录 |
| 状态 | `st_` + SHA1(`主体\|属性\|值\|章号\|序号`) | **章号与序号参与派生**（见下） |
| 认知 | `kn_` + SHA1(`角色\|事实\|信念\|章号\|序号`) | **信念与章号参与派生**（见下） |
| 线索 | `th_` + SHA1(归一化正文) | |
| 伏笔 | `fs_` + SHA1(归一化 seed) | v2.1 新增；空 ID 会断掉整条关联链 |
| **事件** | `ev_` + SHA1(`主体\|属性\|from\|to\|章号\|序号`) | ← R2：一次**转移**的标识（不是记录） |
| **幂等键** | `ik_` + SHA1(`章号\|batchKey\|kind\|内容\|位置`) | ← R2：**提交**的标识（不是结果） |
| **批次指纹** | `bf_` + SHA1(整批变更) | ← R2：判定「同一批抽取」是否重复 |
| **内容指纹** | `cf_` + SHA1(正文) | ← R2：正文一字未改的重跑视为同一提交 |

「归一化」仅用于派生 ID（去空白、去句末标点），**不改动存储的原文**。

### 三个 ID 各司其职（R2 的核心纪律）

评审的第 2 条 caution 明确指出：**不能靠「改哈希内容」来逐个救场**。
所以三者锚定的对象必须根本不同：

| ID | 标识的对象 | 派生自 | 解决的问题 |
|---|---|---|---|
| `state_id` | 一条**记录**（现在是什么） | 记录内容 | 「档案馆→青江桥→档案馆」产生三条不同记录 |
| `event_id` | 一次**转移**（发生了什么） | 一次转移的前后值 | 同一章多次相同变化也能区分 |
| `idempotency_key` | 一次**提交**（是不是重复） | 提交来源（批次+位置），**与结果无关** | 重复提交同一批不重复执行 |

关键推论：**幂等键锚定的是提交，不是结果**。因此
「同一章里两次内容相同的变化」因位置不同 → 键不同 → 是两个事件；
「同一批抽取结果重复提交」因 batchKey 与位置都相同 → 键相同 → 整批判定重复。
两个看似矛盾的要求由「锚定不同对象」同时满足，而不是靠修改某个哈希的输入。

### 为什么状态 / 认知的 ID 必须纳入更多键（v2.1 修复）

第 2 轮评审实测确认：若 ID 只由「主体+属性+值」派生，会出现三种错误：

```
档案馆@2 → 青江桥@3 → 又回档案馆@4
  两次「档案馆」内容相同 ⇒ 第三条被去重吃掉，往返记录丢失

怀疑林晚遇害@1 → 确信林晚遇害@2
  事实文字相同 ⇒ 第二条被去重，认知升级丢失

位置从档案馆改为青江桥
  两条同时 status=active（不结束旧状态）
```

**修法**：把 `sinceChapter`（以及章内 `eventSeq`）纳入 ID 派生。

- 「档案馆@2」与「青江桥@3」→ 不同 ID，可共存（往返不再被拒）
- 「怀疑@1」与「确信@2」→ 因 `belief` + 章号不同 → 不同 ID，可共存（升级不丢失）
- 同一章内同主体同属性多次变更 → `eventSeq` 递增区分

> **R1 与 R2 的分工**：R1 只修正了 **ID 派生**（让不同事件不再互相覆盖，但同一键仍会并列多条 `active`）。
> **R2 补齐了行为**：新状态生效时**自动收尾**同键的旧 `active`（写入 `untilChapter`/`supersededBy`），
> 并把每一次变化记进 `stateEvents`。R1 之后是「一堆互不覆盖但仍然并列的当前值」，
> R2 之后才是「**唯一当前值 + 完整历史**」。
>
> `idempotency_key` 在 R2 已由状态引擎生成并落到事件上；**正式提交机制**（用户确认、乐观并发、
> 写锁、幂等重放）属 **R4**，本阶段只把接入点（`batchKey` / `sourceVersion`）预留并打通，
> 不让尚未确认的正文改写正式状态。

---

## 七、校验规则（`schema.validateProject`）

主要防**悬空引用**与**非法标记**：

- 实体 `id` 不得重复、不得缺失、必须有 `name`
- `outline.cast[].entityId` 必须存在于实体表
- `chapters[].cast[]` 必须引用存在的实体
- `ledger` 各表的 `entityIds` / `subjectId` / `characterId` 必须引用存在的实体
- **账本条目 `trust` 若出现，必须是三个合法值之一**（取值非法会导致隔离判断失效，必须拦下）
- **大纲伏笔必须有非空 `id`**（空 ID 等于「有字段、没关联」）

返回问题列表，空数组表示通过。迁移脚本与测试都以它为验收门槛。
v2.1 起 `store.saveProject()` 也在每次写盘前调用它（结果写入 `lastValidation`）。

---

## 八、标记与运行行为对照表（核心）

第 2 轮评审的共同原则：**任何 `unknown` / `unverified` / `needsReview` / `truncated` 标记
都必须有明确的运行行为，不能只是在 Schema 里多一个字段、默认放行。**

下表逐条列出「标记 → 运行后果 → 可观察证据」：

| 标记 | 取值示例 | 运行行为 | 可观察证据 |
|---|---|---|---|
| `trust: canonical` | 有正文出处 / 作者设定 | **允许**进入正文上下文 | `packet.context.*` 中出现 |
| `trust: legacy_unverified` | 旧数据迁移、无出处 | **隔离**：不进正文，仅计数 | `diagnostics.quarantined.*`、`summary` 含「已隔离」 |
| `trust: needsReview` | 模型推断、冲突未决 | **隔离**：同上 | 同上 |
| `trust` 缺失 | 旧版本遗留 | 按「有无出处」推断：有出处→可信，无出处→**按 legacy_unverified 隔离** | `effectiveTrust()` 的返回值 |
| `visibility: secret` | 作者秘密 | **剔除**，永不进正文 | 不出现在 packet 任何位置 |
| `sourceChapter > 当前章` | 未来章节记录 | **剔除**，计入 `futureSkipped` | `diagnostics.futureSkipped`、`summary` 含「已剔除 N 条未来章节」 |
| `castStatus: unknown` | 大纲无 cast 字段 | 只投影主角，并**把限制写进提示词** | 提示词含「未提供出场名单」；`chapter.castStatus` |
| `castStatus: none` | cast 明确为空数组 | 只投影主角，提示词注明「明确无配角」 | 同上 |
| `cast 悬空引用` | cast 指向不存在的实体 | **阻断编译**，抛错，不静默忽略 | `buildWriterPacket` 抛「引用了不存在的实体」 |
| `truncated.droppedIds` | 超预算未入选的条目 | **不静默截断**：返回被丢弃的 ID 列表 | `diagnostics.truncated.*.droppedIds`、`summary` 含「超预算截断」 |
| `requiredMissing` | 必需事实因时间边界不可见 | **报告**，不静默丢弃 | `diagnostics.requiredMissing`、`summary` 含「必需记录不可用」 |
| `linkStatus: needsReview` | 旧伏笔无章号 | 只保留 ID，**不假装已关联** | 迁移 notes 记录条数；R3 转 `explicit` |

> 设计立场：**默认值是行为，不是装饰。** 例如 `trust` 缺失时不被默认放行，而是按「有无出处」
> 推断；无出处一律隔离。这样即使某份历史数据忘了标 `trust`，也不会污染正文上下文。

---

## 九、上下文编译：三重过滤与时间边界

`ledger.selectContext()` 是上下文层的唯一挑选入口。每个账本条目依次经过**三重过滤**，
缺一不可：

1. **可见性**：`visibility === 'secret'` → 直接剔除（不留痕）。
2. **可信度**：`effectiveTrust(entry) !== canonical` → 进入 `quarantined`，不参与正文。
3. **时间边界**：`isVisibleAt(entry, { chapterNo })` 为假 → 计入 `futureSkipped`。

### 时间边界（v2.1 新增）

```
isVisibleAt(entry, { chapterNo, storyTime })
  出处章号（sourceChapter 或 sinceChapter）> 当前章  → 不可见（future-chapter）
  若双方都带 storyTime 且 entry.storyTime > 当前 storyTime → 不可见（future-story-time）
  否则 → 可见
```

MVP 只实现**章节边界**（出处章号 ≤ 当前章），覆盖了绝大多数「过去章读了未来章」的穿透。
**已知局限（不掩饰）**：同章内的先后顺序、倒叙、多线并行尚未处理。
为此保留 `storyTime` 接口 —— 条目带 `storyTime` 且调用方给出 `storyTime` 时改用它做同章内比较；
未启用时自动退化为章节边界，不影响现有行为。

### 挑选顺序（防「早期事实堆积挤掉晚期新事实」）

- **事实**：必需项（`requiredIds`）强制优先 → 与本章出场实体相关 → 其余按**章号降序**补足
- **当前状态**：只看本章出场主体，且 `status === 'active'`、通过三重过滤
- **角色认知**：只看本章出场角色，且通过三重过滤
- **线索**：本章 `foreshadowIds` 涉及的优先 → 其余未了结的按章号降序排后

第 2 轮评审实测问题 5a：原实现「相关事实只取前 30 条、按插入顺序」会漏掉第 31–40 章。
修法：排序改为**章号降序**，并返回 `truncated` 报告。

> **5a 只有部分修复**：真正的「本章任务明确依赖哪些事实」需要 L2 规划器产出，属 P1。
> R1 只做了三件确定的事：加时间过滤、章号降序、超预算报告。**不声称 5a 已完全修复。**

---

## 十、空出场名单的三态

第 2 轮评审问题 3：**绝不能把「缺少名单」理解为「允许全部」。**

`resolveCast(meta, project)` 返回 `{ status, ids, dangling }`：

| 状态 | 触发条件 | 行为 |
|---|---|---|
| `unknown` | 章节压根没有 `cast` 字段 | 只投影主角；提示词明写「未提供出场名单，不得引入其他有名人物」 |
| `none` | `cast` 是**明确**的空数组 | 只投影主角；提示词明写「明确无配角出场」 |
| `limited` | `cast` 明确列出若干实体 | 主角 + 这些实体 |
| 悬空引用 | `cast` 指向不存在的实体 | **阻断编译**（抛错），不静默忽略 |

三态**互不相同**（有测试断言三者取值集合大小为 3）。
修复前第 22 章 `cast = []` 会把全部 6 个角色放回正文；修复后收敛为 1 人（主角）。

---

## 十一、投影诊断输出

`buildWriterPacket()` 返回的 `diagnostics` **不进入提示词**（`renderWriterPacket` 不读它），
只供日志、界面与测试查看。任何一次剔除、隔离、截断都能在这里说出理由。

```jsonc
"diagnostics": {
  "castStatus": "limited",
  "chapterNo": 3,
  "quarantined": { "facts": ["fact_x"], "states": [], "knowledge": [], "threads": [] },
  "futureSkipped": { "facts": 1, "states": 1, "knowledge": 1, "threads": 1 },
  "requiredMissing": [],
  "truncated": {
    "facts":   { "requested": 40, "included": 30, "droppedIds": ["fact_a", "..."] },
    "threads": { "requested": 12, "included": 12, "droppedIds": [] }
  },
  "summary": ["已剔除 4 条未来章节的记录", "已隔离 1 条来源不可信记录", "超预算截断 10 条"]
}
```

`summary` 是关键的可读摘要，`pipeline.collectContextNotes()` 会把它落进 `chapter.contextNotes`
并输出 `console.warn` —— 这就是「诊断有运行行为」在正文生成路径上的体现。

---

## 十二、迁移（v1 → v2，含 v2-R1 补丁）

`server/migrate.js`，特性：

| 要求 | 实现 |
|---|---|
| 确定性 | 全程不调用模型；无法判断的一律留空，不推测 |
| 可重复执行 | 按 `schemaVersion` 短路；ID 由内容派生，重复跑不会新增记录 |
| 不伪造证据 | 旧记录标 `sourceChapter: null` + `verified: false` + `trust: legacy_unverified` |
| 不改编正文 | `chapters[].text` 原样保留 |
| 可回滚 | 迁移前复制原文件到 `.backups/<id>.pre-v2.<时间戳>.json` |

**迁移映射**：

| v1 | v2 |
|---|---|
| `outline.cast[].name/role/identity` | `entities[]`；`identity` 整体归入 `secret`（无法判别公开部分） |
| `outline.cast[].role` | `authorRole`；「对手/反派」不转为 `publicRole` |
| 章节没有 cast | 从 `summary`/`goal` 中出现的角色名**确定性推断**，标 `castSource: inferred-from-summary` |
| `state.facts[]`（字符串） | `ledger.canonicalFacts[]`，`verified:false`、`sourceChapter:null`、`trust: legacy_unverified` |
| `state.threads[]`（字符串） | `ledger.plotThreads[]`，`status: open`、`trust: legacy_unverified` |
| 大纲伏笔（无 id） | 按 `seed` 派生 `fs_` 稳定 ID；`linkStatus: needsReview`（章号留空） |
| — | `entities[].aliases` 保留旧名，供改名后检索 |

### v2-R1 补丁阶段

`schemaVersion` 仍是 2，但 R1 新增了 `trust` 与伏笔 `id` 这两项**有运行后果**的字段。
已迁移的项目不会重走 v1→v2，因此 `migrateProject` 增加一次**独立、可重复**的补齐：

- 账本条目补 `trust`：有出处 → `canonical`；无出处 → `legacy_unverified`
- 伏笔补 `fs_` ID，`linkStatus` 标 `needsReview`

**幂等**：只补缺、不覆盖已有值；重复执行不改变数据。
`store.getProject()` **每次读取都会问一次是否需要升级**（而不只看版本号），
因为「缺字段但版本号看起来没问题」同样是需要修复的状态。

---

## 十三、访问控制（`server/auth.js`）

不属于数据 Schema，但与数据安全直接相关，一并记录。

| 场景 | 行为 |
|---|---|
| 本机（`127.0.0.1` / `::1`） | 免口令 |
| 局域网其他设备 | 必须携带口令（`X-Mobi-Token` 头或 `?t=` 查询参数），恒定时间比较 |
| API 请求带 `Origin` 且与 `Host` 不一致 | **403**，跨源一律拒绝 |
| `Origin: null`（`file://`、沙箱 iframe） | 403（opaque-origin） |
| 无 `Origin`（curl / 脚本 / 同源导航） | 放行 |

**不再返回任何 `Access-Control-Allow-*` 头** —— 前端与 API 同源，本就不需要 CORS。
第 2 轮评审问题 7 的根因是「回环免口令」与「CORS 通配 `*`」叠加：本机浏览器里的任意网站
都能跨源打到 `127.0.0.1:8787`，走免鉴权路径读作品、触发付费生成。修法是去掉通配 + 校验 Origin。

---

## 十四、状态转移引擎（`server/state-engine.js`，R2）

### 14.1 两段式：先规划，后提交

```js
const plan = planStateChanges(ledger, changes, { chapterNo, batchKey, entities, ... })  // 纯函数，零副作用
const res  = commitStatePlan(ledger, plan)                                             // 原子写回
const res2 = applyStateChanges(ledger, changes, opts)                                  // = 上两步
```

`planStateChanges` **不碰账本**，只根据当前账本 + 这一批变更算出「将要新增/收尾什么」。
`commitStatePlan` 把所有新数组在**局部变量**里构造完整，最后**一次性写回** `ledger` 的五个字段。

> 这就是单线程 Node 里实现「原子性」的办法：中途不写回，任何一步抛出或前置校验失败，
> 账本对象的那五个引用根本没被替换，因而**逐字不变**（用 `JSON.stringify` 比较验证）。

### 14.2 收尾（supersede）规则

- **状态**：按 `(subjectId, attribute)` 归并；新记录落定后，该键所有旧 `active` 记录一起转
  `superseded`，写入 `untilChapter = 新记录章号`、`supersededBy = 新记录 id`。
- **认知**：按 `(characterId, 归一化 fact)` 归并 —— 认知演变**就是同一条事实在不同信念层级上的视图**。
- 同一批内**链式转移**在「工作视图」上推进，因此同章的 `A→B→A` 三次变化按序生效，互不吞并。

### 14.3 违规分级与失败保护

| 级别 | 触发例 | 行为 |
|---|---|---|
| `error` | 时间倒退（新值早于当前值）、主体解析不到实体、缺属性/取值 | **整批拒绝**，账本一字不改 |
| `warning` | 单条无法归并 / 模型噪声 | **只跳过该条**，其余照常落账 |

`applyExtraction` 里**状态引擎先跑**，跑完确认没被拒绝，才继续写事实与线索 ——
这样「一批里有一项非法 → 整批不落」覆盖到**全部四类账本**，而不是只有状态表干净。
（顺序是被测试逼出来的：先写事实再跑状态引擎，拒绝时事实已经进去了，回不去。）

### 14.4 查询接口

| 函数 | 回答的问题 |
|---|---|
| `queryStateAt(project, { subjectId, attribute, chapterNo })` | **第 N 章时**某主体某属性的有效取值 |
| `queryStateTimeline(project, { subjectId, attribute })` | 该键的**完整轨迹**（含已替代的历史） |
| `queryKnowledgeAt(project, { characterId, chapterNo })` | 第 N 章时某角色知道/相信/怀疑什么 |
| `queryKnowledgeHistory(project, { characterId, fact })` | 某条事实的**认知演变史**（suspects→believes→knows） |

### 14.5 旧形状账本补事件（`backfillTransitions`）

真实旧作品（《十年雨信》）里 **一条状态/认知记录都没有** ——
因为 v1 的数据结构只有 `state.facts / state.threads / state.lastSummary`，
**从来没有「当前状态」与「角色认知」的槽位**。这不是迁移丢失，是原来就没有。

对**真有**旧形状状态记录的作品，`backfillTransitions` 做确定性补齐：

- 同键多条 `active` → 只留最后一条 `active`，其余写 `untilChapter` 收尾
- 缺 `eventId` 的记录 → 补一条事件，`fromValue` **一律留空**（旧数据不知道上一个取值，不编造）
- 全程不调模型、只补不覆盖、重复执行结果逐字一致

### 14.6 接入流水线的两个钩子（R2-c）

`pipeline.js` 落账时向状态引擎传入：

```js
const sourceVersion = (Number(project.headVersion) || 0) + 1   // 出处正文版本
const batchKey = `ch${chapterNo}:${contentFingerprint(body)}`  // 提交标识
```

`batchKey` 取「章号 + **正文内容指纹**」：正文一字未改的重跑 → 同一 batchKey → 判为重复提交；
正文改过的重跑 → 不同 batchKey → 是一次**新提交**。锚定提交，不锚定结果。
提交后 `project.headVersion` 被设为与 `sourceVersion` **完全相同的数**，二者不许漂移。

> **R2 的边界（必须说明）**：这两个钩子只是**接入点**，`batchKey`/`sourceVersion` 尚由服务端
> 单方决定，用户确认、乐观并发校验、写锁与幂等重放属 **R4「可靠提交」**，本阶段不启用。
> 换句话说，R2 只保证了「状态引擎本身正确、原子、可重复」，**尚未**保证
> 「只有被确认的正文才能改写正式状态」。

### 14.7 实测样例

`mobi/docs/R2_状态转移样例.md`（由 `scripts/demo-state-transitions.mjs` 生成，非手写）
用真实作品的实体与线索，逐场景打印转移前后的账本真实内容，覆盖：
同章往返、按章回查、认知演变、失败保护（逐字比对）、重复提交、
证据溯源（三 ID 对照表）、旧形状补齐。

