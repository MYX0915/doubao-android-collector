# 豆包 App 扫码登录链路分析

## 1. 范围与结论

本说明分析使用豆包 Android App 扫描 `/inapp/scan-login` 登录二维码的流程，覆盖扫码结果分发、App 内网页打开、页面参数、扫码状态更新、确认或取消登录，以及原生请求桥接。

该流程与飞书 `accounts.feishu.cn/accounts/page/qrlogin/doubao` 分支不同，不使用该分支的 `qrlogin.token` JSON 解析器，也不能套用其专用认证 Cookie 同步机制。

已定位的核心流程是：页面读取 `next_url`，通过 App 请求桥接发送第一次 POST；从返回结果取得 `confirmed_url`；用户确认或取消后向该地址发送第二次 POST。两次调用都传入页面查询参数，并启用 `addCommonParams`。

目前完成的是 APK 静态分析和公开页面脚本分析，没有进行真实扫码登录抓包、提交确认登录、读取设备凭证或实现自动登录脚本。不同版本的 APK 与远程页面能否按下述链路实际联动，仍需运行验证。来源、版本和具体定位见附录。

## 2. 完整流程

```text
待登录端取得登录二维码
  │  二维码生成接口、响应结构、待登录端状态监听：未验证
  ▼
豆包 App 扫码，获得 /inapp/scan-login?... URL
  ▼
CameraScanLogic.a(String)
  → 普通网页分支，将完整 URL 放入 link_url
  → platform.service.q.d(...)
  → home.impl.sdk.e1.d(...)
  → SearchServiceImpl.d(...) → n(...)
  → //flow/webview → App 内网页容器
  ▼
网页初始化
  → 检查 App 环境
  → 通过桥接 getUserInfo() 检查已登录状态
  → 从页面 query 读取 next_url 并校验其 URL 前缀
  ▼
第一次 POST：更新二维码扫描状态
  url = pageQuery.next_url
  params = 页面 query 的浅拷贝
  addCommonParams = true
  ▼
读取处理后的返回数据：risklevel、confirmed_url
  ├─ risklevel == 3 → 风险提示页
  ├─ 请求异常 → 错误状态，可重新扫描
  └─ 普通成功分支 → 保存 confirmed_url，显示确认界面
       ▼
第二次 POST：提交用户决定
  url = confirmed_url
  params = Object.assign({ decision }, pageQuery)
  addCommonParams = true
  ├─ 确认按钮传 decision = 0
  └─ 返回/符合条件的退出清理传 decision = 1
       ▼
请求成功后关闭 App 内页面
  │  待登录端收到成功状态、建立会话：未验证
```

上述“请求成功”指页面调用的响应处理函数没有抛出异常，不等于已通过运行测试确认另一端登录成功。

## 3. Android 扫码入口与页面加载

### 3.1 扫码结果分发

`CameraScanLogic.a(String)` 接收二维码识别后的原始文本。对于目标网页链接，普通网页分支把完整 URL 放进 Bundle 的 `link_url` 字段，再交给浏览器服务。该分支包含测试环境域名适配逻辑，但没有在这里拆出登录业务参数并构造确认登录请求。

浏览器服务经过 `platform.service.q`、`home.impl.sdk.e1` 转发，最终由 `SearchServiceImpl.n(...)` 使用 `SmartRouter` 打开 `//flow/webview`，并传入 Bundle。

`/inapp/scan-login` 字符串的专门判断位于扫码结果分类逻辑：匹配 App 站点地址与该路径前缀后，将 `scan_qr_code_result` 事件的结果标为 `login`。该判断是埋点分类，不是登录接口调用。

### 3.2 页面地址与参数层次

App 配置中的站点地址为 `https://www.doubao.com`。目标页面为该站点下的 `/inapp/scan-login`，登录业务参数来自具体二维码携带的查询字符串。

| 参数层 | 字段 | 含义与限制 |
|---|---|---|
| App 内路由 | `link_url` | 完整目标页面地址；不是确认登录接口的 Body 字段 |
| 页面 query | `next_url` | 第一次 POST 的目标地址 |
| 页面 query | `enter_from` | 页面日志事件读取的来源字段；因整体 query 被传递，也可能随请求发送 |
| 页面 query | 其他二维码原有字段 | 页面整体传递；尚无脱敏二维码样本，不能枚举完整清单 |
| WebView 公共 query | `is_inapp=1` | 白名单条件成立时添加 |
| WebView 公共 query | `api_host` | 白名单条件成立时使用 App 配置的 API 地址 |
| WebView 公共 query | `theme` | 公共处理根据界面主题添加 `light` 或 `dark` |

WebView 公共处理还包含特殊的 fragment/query 兼容分支。实际页面最终读到哪些字段，应以运行时页面地址和 query 解析结果为准，不应直接把所有原生路由字段当成登录 API 的必填字段。

### 3.3 页面加载请求头

本地 APK 的 WebView 公共请求处理在白名单条件成立时增加 `x-tt-token`，值来自 App 配置的回调。测试环境条件分支还涉及 `x-use-boe`、`x-use-ppe` 与 `x-tt-env`。

这些是页面加载层的静态证据，不证明两次桥接 POST 使用完全相同的 Header，也不证明生产环境必须带测试环境字段。没有读取或保存实际 token 值。

## 4. 页面业务请求

### 4.1 前置检查

公开页面脚本的普通初始化路径依次执行：

1. 检查是否处于 App 环境；不满足时导航到 `/outside`。
2. 调用桥接 `getUserInfo()`，通过返回结果判断登录状态；未登录时提示并关闭页面。
3. 从页面 query 读取 `next_url`；不存在或不符合校验时提示错误，不发送扫码状态请求。

页面的 `next_url` 正则校验包含以下路径前缀：

```text
http(s)://www.doubao.com/passport/sso/scan_qrcode
http(s)://www.doubao.com/passport/web/scan_qrcode
http(s)://www.doubao.com/passport/mobile/scan_qrcode
```

这是对脚本前缀匹配行为的描述，不是三个接口都已调用成功的实测清单，也不是完整的服务端 URL 安全规则。

### 4.2 第一次 POST：更新扫描状态

以下是从页面脚本还原的调用结构，不是可直接执行的登录客户端：

```javascript
const scanResult = await appBridge.request({
  url: pageQuery.next_url,
  method: "POST",
  params: { ...pageQuery },
  addCommonParams: true
});
```

`appBridge`、`pageQuery` 是说明用名称。源码调用的是导入对象的 `x.request(...)`，并对桥接返回值进一步执行响应处理函数。

| 项目 | 已确认行为 |
|---|---|
| URL | 使用 `pageQuery.next_url`，不是请求 `/inapp/scan-login` 页面本身 |
| Method | `POST` |
| `params` | 页面 query 的浅拷贝，不是二维码生成接口的完整 JSON 响应 |
| `addCommonParams` | `true`；这是桥接选项，不应直接当作服务端同名业务字段 |
| `body`、`header` | 这段页面调用没有显式设置 |
| 响应处理 | 读取处理后的数据对象中的 `risklevel` 与 `confirmed_url` |

`risklevel === 3` 对应脚本中的 `RateLimited`，页面导航到 `/risk`。普通成功分支保存 `confirmed_url` 并进入成功显示状态；请求异常进入错误状态。底层原始响应封装、HTTP 状态码与完整错误字段尚未通过抓包确认。

### 4.3 第二次 POST：确认或取消

```javascript
await appBridge.request({
  url: confirmedUrl,
  method: "POST",
  params: Object.assign({ decision }, pageQuery),
  addCommonParams: true
});
```

| 项目 | 已确认行为 |
|---|---|
| URL | 第一次请求处理结果中的 `confirmed_url`，没有在页面内固定拼接确认接口 |
| 确认按钮 | 调用确认函数时传入 `decision = 0` |
| 返回/取消 | 传入 `decision = 1` |
| 页面退出清理 | 仅在对应状态标记允许、没有提交中的请求时尝试取消 |
| 请求保护 | `confirmed_url` 为空或已有提交中的请求时直接返回 |
| 成功处理 | 关闭页面 |
| 失败处理 | 记录错误；非静默失败路径显示可重新扫描的提示 |

参数合并顺序是先 `{ decision }`、后 `pageQuery`。若 query 本身也有同名字段，JavaScript 合并结果会覆盖前值；不能把示意代码擅自改写为相反顺序。尚未观察到实际二维码含该同名字段，也未验证服务端如何处理这种输入。

## 5. 原生请求桥接与 HTTP 参数

本地 APK 存在名为 `request` 的 `com.larus.xbridge.custom.RequestMethod`。其参数定义包括 `url`、`method`、`params`、`body`、`bodyType`、`header`、`addCommonParams`、`useUIThread` 和 `usePrefetch`。

| 输入 | 本地原生实现中的处理 |
|---|---|
| `params` | 与 URL 一同交给 `ke7.e.a(...)` 构造目标地址 |
| `addCommonParams=true` | Web 平台的地址构造增加 `request_tag_from=h5`，并选择带公共处理的宿主网络依赖 |
| `body` | 独立读取；字符串、数组、Map 与未提供值走不同处理分支 |
| `header` | 独立读取、规范化后交给网络层 |
| POST 未指定 `Content-Type` | 该分支默认使用 `application/x-www-form-urlencoded` |
| 未提供 `body` | 该分支构造空 `JSONObject` 再交给下游序列化，不代表线上一定发送字面量 `{}` |

因此，页面传入的 `params` 不能直接描述为“JSON 请求体”。具体 HTTP Body 字节、宿主追加的公共字段、认证头、Cookie、签名或设备信息仍需网络层样本核对。

公开页面导入的 `x.request` 与本地注册的同名桥接在接口形状上吻合，但其包装模块到该 APK 实现的运行时分发尚未直接验证；公开页面和 APK 的版本也不构成已验证的配套版本。本文将两部分作为可核查的静态证据串联，而非已通过端到端测试的抓包结果。

## 6. 可行性判断与验证缺口

### 6.1 省略摄像头扫描

若已取得同一待登录会话对应的完整二维码 URL，将它交给 App 原有网页入口，在输入形态上可以替代摄像头识别出的字符串。该判断来自原生入口的参数与调用关系，尚未实际执行验证。

这不等于对页面发一次普通 GET 就完成登录，也不等于获得二维码生成接口的响应后可原样提交。页面仍会检查 App 环境与登录状态，并执行扫码状态更新及用户确认流程。

### 6.2 尚待验证

| 缺口 | 需要的证据 |
|---|---|
| 二维码业务字段全貌 | 一份脱敏的二维码生成响应及解码后的 URL，保留字段名、嵌套与编码关系 |
| 页面真实版本与包装行为 | App 实际加载的页面资源版本及 `x.request` 包装模块 |
| 原生桥接是否走已定位实现 | 一次正常扫码期间的桥接方法、参数名和时序观察 |
| 第一次请求 | 实际 method、目标路径、query、header 名称、body 格式及脱敏响应 |
| 第二次请求 | `confirmed_url` 的来源、确认与取消的实际参数及脱敏响应 |
| 公共认证与设备字段 | 宿主网络层最终发送字段的名称和来源；凭证值不进入文档 |
| 待登录端状态同步 | 正常流程中待登录端自己的请求或事件记录，确认是轮询还是其他机制 |
| 完整成功条件 | 手机确认后，待登录端实际建立会话并呈现正确账号 |

后续验证以本人账号的正常扫码操作为样本，不重放未知来源的二维码、不替换确认目标、不把 HTTP 200 单独作为登录成功证据。

## 附录 A：证据范围与版本快照

核实日期：2026-10-14。

| 对象 | 位置或版本 |
|---|---|
| 项目目录 | `/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler` |
| 原始 APK | `device_work/original/com.larus.nova.base.apk` |
| 解码目录 | `device_work/decompiled/` |
| APK 版本 | `versionName=15.1.0`、`versionCode=15010040`，来自 `apktool.yml` |
| 公开页面 | `https://www.doubao.com/inapp/scan-login` |
| 页面模块版本 | `@flow-web/vmok-consumer-inapp:1.0.0.847` |
| 业务脚本 | `scan-login_page.fd666f6d.js` |
| 使用工具 | 现有 Apktool/Smali 产物、`rg`/`sed` 静态定位、`curl` 只读获取公开 HTML/JS |
| 未执行操作 | 未注入扫码 Hook、未提交扫码或确认接口、未提取实际凭证、未实现自动登录 |

公开资源已在分析期间读取，但未在项目中保存 HTML/JS 原始快照；下述 URL 是远程来源，不是本地归档。远程资源下线或更新后，应重新核对，不能只依据模块编号推断新版本。

## 附录 B：Android 文件与行号

以下行号是当前 Smali 文件的文本行号，不是 Smali 内部 `.line` 指令标注的源代码行号。

| 对应内容 | 文件位置 | 定位锚点 |
|---|---|---|
| §3 扫码网页分发 | [CameraScanLogic.smali:2033](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes21/com/larus/camera/impl/utils/CameraScanLogic.smali:2033) | `service/q;->d`，调用在 2074 行 |
| §3 登录分类埋点 | [CameraScanLogic.smali:2165](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes21/com/larus/camera/impl/utils/CameraScanLogic.smali:2165) | `/inapp/scan-login`；事件名在 2300 行 |
| §3 浏览器服务转发 | [q.smali:213](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes25/com/larus/platform/service/q.smali:213) | `d(Context, Bundle, HybridEventParams)` |
| §3 浏览器接口适配 | [e1.smali:212](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes22/com/larus/home/impl/sdk/e1.smali:212) | `IBrowserService;->d` |
| §3 网页打开 | [SearchServiceImpl.smali:467](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes25/com/larus/search/impl/SearchServiceImpl.smali:467) | `n(...)`、`//flow/webview` |
| §3 站点地址构造 | [HttpConstImpl.smali:390](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes25/com/larus/network/HttpConstImpl.smali:390) | `doubao.com`、`www.`、`https://` |
| §3 白名单检查 | [WebFragment.smali:5259](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes25/com/larus/search/impl/WebFragment.smali:5259) | `a50`；`O40` 入口在 1540 行 |
| §3 公共 query | [WebFragment$e.smali:1370](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes25/com/larus/search/impl/WebFragment$e.smali:1370) | `is_inapp`、`api_host`、`M40` |
| §3 公共 Header | [WebFragment$e.smali:1675](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes25/com/larus/search/impl/WebFragment$e.smali:1675) | `x-tt-token`、`x-tt-env` |
| §5 桥接参数定义 | [RequestMethod.smali:24](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes26/com/larus/xbridge/custom/RequestMethod.smali:24) | `XBridgeMethodName`、`params`、`body` |
| §5 分开读取 Body 与 query | [RequestMethod.smali:1167](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes26/com/larus/xbridge/custom/RequestMethod.smali:1167) | `getHeader`、`getBody`、`getParams` |
| §5 POST 分支 | [t1.smali:523](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes26/com/larus/xbridge/custom/t1.smali:523) | `application/x-www-form-urlencoded` |
| §5 URL 参数合并 | [ke7/e.smali:44](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes16/ke7/e.smali:44) | `a(String, Map, PlatformType, boolean)`；`request_tag_from` 在 233 行 |
| §5 请求体下游处理 | [ke7/e.smali:2133](/Users/mnb/Desktop/逆向/移动端逆向-豆包/test-mob_crawler/device_work/decompiled/smali_classes16/ke7/e.smali:2133) | `o(...)` → `p(...)` |

## 附录 C：公开页面脚本位置

- [页面入口与资源清单](https://www.doubao.com/inapp/scan-login)
- [业务脚本 scan-login_page.fd666f6d.js](https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao/inapp/static/js/async/scan-login_page.fd666f6d.js)

业务脚本是压缩单行文件，用模块编号与字符串锚点定位比格式化后的行号稳定。

| 对应内容 | 脚本模块 | 检索锚点 |
|---|---|---|
| §2、§4 页面主逻辑 | `46615` | `getUserInfo`、`next_url`、`confirmed_url` |
| §4 扫码状态请求 | `80883`，导出 `at` | `url:e,method:"POST",params:t,addCommonParams:!0` |
| §4 确认请求 | `80883`，导出 `zq` | `module:"scan-login"`、`emptyDataIsTrue:!0` |
| §4 next_url 校验 | `20554` | `/passport/(sso|web|mobile)/scan_qrcode` |
| §4 确认与取消 | `46615` | `decision:e`、`I(0)`、`I(1,!0)` |
| §4 风险判断 | `80883`、`46615` | `RateLimited=3`、`/risk` |
| §4 App 外访问 | `46615` | `scan_login_open_it_outside`、`/outside` |
| §4 请求时序日志 | `46615` | `scan_login_change_code_status_success`、`scan_login_send_confirm_request_success` |

`confirmed_url` 和 `risklevel` 是页面响应处理后的对象字段；原始 HTTP 响应是否还有外层包装，不能仅凭这两个访问表达式确定。
