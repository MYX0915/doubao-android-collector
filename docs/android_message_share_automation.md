# Android SSE 完成后自动生成对话分享链接

## 目标与边界

本方案在已授权的 Android 测试设备中监听 App 自己发起的 `/chat/completion` SSE。回答完成后，Hook 从 SSE 中取得会话 ID 和消息 ID 列表，再通过 App 内部网络层创建分享记录并保存返回的分享链接。

整个流程不点击分享 UI，不在 Python 中重放 HTTP 请求，也不复制或生成 App 的登录凭证、动态 Header、设备证明和安全参数。

## 运行入口

完整采集流程与三个输出文件的用法见 [项目说明](../README.md)。正式采集入口：

```bash
./.venv-frida/bin/python tools/capture_complete_conversation.py --seconds 600
```

只需独立观察分享请求和响应时使用：

```bash
adb forward tcp:27042 tcp:27042
./.venv-frida/bin/python tools/capture_message_share.py --seconds 300
```

启动后在 App 中新建对话并发送问题。Hook 会在 SSE 回答结束后自动完成分享请求。

相关文件：

| 文件 | 用途 |
|---|---|
| `tools/capture_complete_conversation.py` | 正式采集入口，输出完整 SSE、完整消息和独立商品卡三个文件 |
| `tools/parse_android_sse.py` | 解析 SSE，提取问题相关字段、回答、引用和商品卡 |
| `hooks/capture_message_share.js` | 捕获 SSE 上下文、调用 App 内部分享网络层、解析响应 |
| `tools/capture_message_share.py` | 连接 Frida、加载 Hook、保存 JSONL |
| `data/runtime/message_share_capture.jsonl` | 本地运行结果；包含请求和分享响应 |

## 分享接口

当前 App 使用：

```text
POST /im/message/share/save
```

兼容代码中还保留旧接口：

```text
POST /alice/message/share/save
```

请求模型为 `com.larus.bmhome.share.network.f`，对应源码语义名 `SaveMessageRequest`：

| JSON 字段 | 类型 | 含义 |
|---|---|---|
| `conv_id` | string | 会话 ID |
| `message_id_list` | string[] | 需要分享的消息 ID；问答对通常包含两个 ID |
| `enable_generate_title` | boolean | 是否让服务端生成分享标题 |
| `is_allow_seo` | boolean | 是否允许 SEO |
| `share_total_conversation` | boolean/null | 是否分享整个会话 |

自动请求使用：

```json
{
  "enable_generate_title": true,
  "is_allow_seo": false,
  "share_total_conversation": false
}
```

响应模型为 `com.larus.bmhome.share.network.SaveMessageShareInfo`：

| 字段 | 含义 |
|---|---|
| `shareId` | 分享记录 ID |
| `shareUrl` | 可访问的对话分享链接 |
| `qrCodeUrl` | 分享二维码短链接 |

## 编译包调用链

### UI 分享链

手动点击分享时，App 先在 `MessageShareViewModel` 中维护待分享消息：

```text
ChatShareBottomComponent
  → MessageShareViewModel.enterSelectMode(..., currentList, ...)
  → MessageShareViewModel.selectRelativeMessage(...)
  → shareMsgIds: ConcurrentHashMap<localMessageId, Message>
  → shareMessageWithPreload(ShareItemConfig)
```

`shareMessageWithPreload` 将网络结果发布到 LiveData：

```text
kotlin.Pair(
  first  = BizResponse<SaveMessageShareInfo>,
  second = ShareItemConfig
)
```

因此 UI 路径的正确响应读取位置是：

```text
Pair.first
  → BizResponse.data
  → SaveMessageShareInfo
  → shareId / shareUrl / qrCodeUrl
```

`Pair.second` 是分享面板配置，不包含接口响应。

### 无 UI 自动分享链

自动流程不调用 `enterSelectMode()` 或其他 UI 方法，而是直接复用 App 网络层：

```text
SSE 完成
  → 收集 conv_id
  → 收集用户消息 ID 和回答消息 ID
  → 构造 SaveMessageRequest
  → PreloadMessageShareHelper.a(CoroutineScope, request)
  → MessageShareApi.Companion.a(request, continuation)
  → ej9.a$b（Success）
  → BizResponse.data
  → SaveMessageShareInfo
```

网络调用运行在 App 的协程环境中，HTTP、TLS、登录态和动态安全参数仍由 App 负责。

## SSE 上下文提取

Hook 观察以下 TTNet/Cronet 入口：

```text
com.bytedance.frameworks.baselib.network.http.cronet.impl.BaseCronetSsCall
com.bytedance.frameworks.baselib.network.http.ok3.impl.Ok3SsCall
com.ttnet.org.chromium.net.urlconnection.CronetInputStream.read(...)
```

每条 `data:` 事件会递归查找：

```text
conversation_id / conversationId / conv_id
message_id
message_id_list
```

分享请求只在整条回答最终结束后触发：

```text
顶层 end_type=3
[DONE]（传输层兜底）
```

`end_type=1` 和 `end_type=2` 是中间阶段，嵌套的 `content_block.is_finish=true` 只表示单个内容块结束，均不得触发分享。最终结束后延迟 1.5 秒发起分享，使完整回答先写入 App 会话状态。

## 并发采集设计（暂不实现）

后续如果需要在回答尚未完成时继续新建对话并发送问题，不能使用单组全局 SSE 状态。每条回答必须按会话和轮次隔离。

业务主键使用 `conversation_id`，同一会话内再使用 `request_id` 或 `stream_id` 区分不同轮次：

```text
capture_key = conversation_id + request_id/stream_id
```

建议的运行时状态结构：

```text
conversations[conversation_id].active_requests[request_id] = {
  sse_raw,
  question,
  message_ids,
  keywords,
  answer,
  citations,
  product_cards,
  finished,
  share_result
}
```

处理规则：

1. 从 `/chat/completion` 请求体提前取得 `conversation_id`，并为该请求建立 `request_id`；
2. 按 `conversation_id + request_id` 记录 SSE、消息 ID、问题和回答内容；
3. 只对该请求收到顶层 `end_type=3` 的状态标记为完成；
4. 只使用该请求对应的用户消息 ID和回答消息 ID调用分享接口；
5. 为每个请求独立保存完整 SSE、完整消息内容、商品卡片和分享结果；
6. 同一账号的并发数量、不同账号的设备实例和请求间隔单独控制。

`conversation_id` 作为业务主键可以避免不同新建对话串数据；`request_id/stream_id` 是必要的轮次隔离键，因为同一个会话可能连续发送多轮问题。当前 Hook 仍使用单会话全局状态，暂不支持该并发模型。

## 响应捕获

自动请求的最终结果由 `ej9.a` 封装：

```text
ej9.a$b = Success
ej9.a$a = Error
```

Hook 在 `Success` 构造时读取 `BizResponse.data`。当数据类型为 `SaveMessageShareInfo` 时，写入：

```json
{
  "type": "message_share_response_auto",
  "value": {
    "share_id": "...",
    "share_url": "https://www.doubao.com/thread/...",
    "qr_code_url": "https://s.doubao.com/.../"
  }
}
```

这种位置比轮询 `PreloadMessageShareHelper.a` 更可靠。该类同时存在字段 `a` 和方法 `a(...)`，运行时桥接容易产生命名冲突。

## 已验证流程

核实日期：2026-09-24。

实测自动流程：

```text
新建对话并发送问题
  → SSE 回答完成
  → 自动取得一个 conv_id 和两个 message_id
  → App 内部调用 /im/message/share/save
  → 捕获 Success<SaveMessageShareInfo>
  → 保存分享链接 JSON
```

验证响应示例：

```json
{
  "share_id": "xVSYnbcijqxpFxu73",
  "share_url": "https://www.doubao.com/thread/xVSYnbcijqxpFxu73",
  "qr_code_url": "https://s.doubao.com/BfnpTAGb7zU/"
}
```

## 故障判断

### 只能看到请求，无法看到链接

检查是否出现以下事件：

```text
app_internal_share_api_success
message_share_response_auto
app_internal_share_api_error
```

只轮询 `PreloadMessageShareHelper.a` 可能因字段与方法同名而读不到结果，应以 `ej9.a$b` 的 `BizResponse.data` 为准。

### App 在 SSE 完成后退出

不要从 Frida 的延迟回调线程调用：

```text
ChatShareBottomComponent.G2()
MessageShareViewModel.enterSelectMode(...)
```

这些方法属于 UI 选择状态链。自动分享应只调用 `PreloadMessageShareHelper` 网络层。

### 消息 ID 只有一个

分享问答对需要同时保留用户消息 ID 和回答消息 ID。Hook 应在整条 SSE 中累积去重，不能只保留最后一个 `message_id`。

### 手动分享能成功，自动请求失败

对比请求中的：

```text
conv_id
message_id_list
enable_generate_title
is_allow_seo
share_total_conversation
```

当前验证配置要求 `enable_generate_title=true`，并在回答结束后等待最终消息提交。

## 数据安全

- JSONL 可能包含会话 ID、消息 ID 和公开分享链接，只保存在本地测试环境；
- 不在文档或共享日志中记录 Token、Cookie、Ticket Guard 和完整设备标识；
- 不使用历史凭证重放接口；
- 仅在自有或明确授权的设备与账号中运行。
