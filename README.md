# Android 对话数据采集

通过 Frida 监听豆包 Android App 实际发出的 `/chat/completion` SSE，提取问题、搜索关键词、回答正文、引用网页和商品卡片。回答完成后，复用 App 内部网络层创建对话分享链接，输出三个 UTF-8 文件。

问题由用户在 App UI 中发送。采集程序负责监听和保存；登录态和网络请求由 App 管理。当前支持单次运行采集一轮问答。

## 能力与运行原理

项目完成了从 App 问答到本地结构化数据的单轮采集链路：

```text
Python 连接 Frida 并加载 Hook
  → 用户在 App UI 发送问题
  → 捕获 /chat/completion 请求体中的问题与会话上下文
  → 监听对应输入流，累积字节并按 UTF-8 解码 SSE
  → 从响应收集会话 ID、用户消息 ID 和回答消息 ID
  → 顶层 end_type=3，等待 1.5 秒
  → 在 App 内调用分享接口，捕获分享响应
  → 卸载 Hook，拉取设备 SSE 文件
  → 解析回答、搜索、引用和商品信息，保存三个文件
```

Python 主程序负责连接设备、管理监听时间、接收 Hook 事件、拉取日志和生成 JSON。JavaScript Hook 负责观察 App 请求与响应，并调用 App 自身的分享网络层。解析器负责展开 SSE 中嵌套的 JSON 字符串，提取业务字段和商品卡信息。

监听入口为 `BaseCronetSsCall/Ok3SsCall.inputStream()` 及返回流的 `read(...)`，请求上下文来自 `prepareNetworkRequest(...)`。SSE 先累积到完整行再解码，避免中文 UTF-8 字符被网络读取边界拆开。完整 SSE 在 App 外部文件目录的 `doubao_complete_sse.log` 保存，主机通过 ADB 拉取，避免把大段 SSE 放入 Hook 事件通道。

分享链路为 `PreloadMessageShareHelper → MessageShareApi → BizResponse<SaveMessageShareInfo>`。请求使用当前问答的消息 ID 列表，响应提供分享 URL 和二维码 URL。接口模型与反编译调用链见 [技术说明](docs/android_message_share_automation.md)。

## 技术栈与工具

### 采集运行技术栈

| 技术或组件 | 项目中的用途 | 运行要求 |
|---|---|---|
| Python + venv | 主机侧采集调度、等待响应、拉取文件、解析和写入 JSON | 必需，使用 `.venv-frida` |
| Frida Python SDK | 连接设备端服务、附加 App、加载 Hook、接收事件 | 必需，版本见 `requirements.txt` |
| JavaScript + Frida Java Bridge | 在 App 进程中 Hook Java 方法、读取请求和 SSE、调用内部分享方法 | 必需，由 Frida 加载执行 |
| Android frida-server | 提供设备端进程附加与脚本执行能力 | 必需，版本与客户端匹配，二进制架构与设备 ABI 匹配 |
| Android SDK Platform-Tools / ADB | 设备连接、TCP 端口转发、通过 `exec-out cat` 拉取 SSE | 必需，`adb` 需在 PATH 中 |
| Python 标准库 | `argparse` 处理参数；`threading` 管理等待；`subprocess` 调用 ADB；`json`、`pathlib`、`urllib.parse` 处理数据 | 随 Python 提供 |
| SSE、JSON、UTF-8 | 接收流式回答、保存结构化内容、正确编码中文 | 输出数据格式 |

App 侧被观察和复用的组件包括 Java/ART 运行环境、TTNet/Cronet 网络栈、Java 输入输出流、Kotlin 协程及 App 自身分享网络模型。这些组件由目标 App 提供，不是主机端需要另外安装的 Python 依赖。采集程序不依赖数据库、Web 服务或前端框架。

### 逆向分析与辅助工具

| 工具 | 用途 | 是否为日常采集必需 |
|---|---|---|
| Apktool | 解码 APK 资源和 Smali，保留静态分析资料，核对类与方法调用链 | 否；已有分析资料位于 `device_work/decompiled/` |
| JADX | 阅读反编译 Java 代码的辅助工具；复杂调用可结合 Smali 核对 | 否；本机已安装，不代表所有定位都经由 JADX 完成 |
| JDK / Java | 运行 Apktool、JADX 等 Java 分析工具 | 否 |
| frida-tools | Frida 命令行诊断工具集；正式脚本直接使用 Python SDK | 否 |
| Node.js | 使用 `node --check` 检查 Hook JavaScript 语法 | 否；Hook 实际在 Frida 中执行 |
| jq | 本地查看和筛选 JSON 示例及采集结果 | 否 |
| Android 模拟器或可附加的真机 | 运行已登录的目标 App 与 frida-server | 必需有一台可用设备；已验证环境见附录 |

## 项目结构

```text
test-mob_crawler/
├── README.md
├── requirements.txt
├── hooks/
│   └── capture_message_share.js        # SSE 监听、上下文提取与自动分享
├── tools/
│   ├── capture_complete_conversation.py # 正式入口：生成三个文件
│   ├── parse_android_sse.py             # SSE 解析与商品字段提取
│   └── capture_message_share.py         # 独立分享监听入口，输出 JSONL
├── docs/
│   └── android_message_share_automation.md
├── data/
│   ├── examples/newborn_formula/        # 保留的完整项目示例，三个原始采集文件
│   └── runtime/                        # 本地运行输出，默认不纳入版本控制
├── device_work/
│   ├── original/                       # 原始 APK，供后续版本对照
│   └── decompiled/                     # 反编译分析资料，运行时不依赖
└── .venv-frida/                         # 本机 Python 运行环境
```

## 环境准备

- Python 3.9 或兼容版本；
- `adb` 可在终端调用，`adb devices` 能识别目标设备；
- 设备已运行匹配客户端版本的 frida-server，并允许附加目标 App；
- 豆包已启动、已登录，默认进程名为 `豆包`；
- 单次只连接一台目标设备，避免 ADB 拉取文件时设备选择不明确。

项目已有 `.venv-frida` 时可直接使用。重新建立环境：

```bash
python3 -m venv .venv-frida
./.venv-frida/bin/python -m pip install -r requirements.txt
```

依赖锁定为本机已使用的 Frida 客户端版本。升级 App 或 Frida 后需要重新验证 Hook 类名、方法签名和响应字段。

环境准备不由采集脚本自动完成：设备端 frida-server 需要预先启动，脚本也不会自动打开 App、登录账号或发送问题。当前 UI 操作由用户完成。

主机通过 `127.0.0.1:27042` 连接 Frida，ADB 将主机端口转发到设备 `27042`。设备需要具备允许 frida-server 附加目标进程的权限；普通未配置设备不能仅靠安装 Python 依赖完成注入。完整 SSE 的设备路径为 App 外部文件目录下的 `doubao_complete_sse.log`，当前包名为 `com.larus.nova`。

迁移电脑时应重新建立 `.venv-frida`，不要直接复制虚拟环境。迁移设备时先核对 Android ABI，再准备相应的 frida-server；不能根据主机是 arm64 就推断目标设备也使用 arm64。其他主机系统和设备组合需重新验证。

可用以下命令检查基础环境：

```bash
./.venv-frida/bin/python --version
./.venv-frida/bin/python -c 'import frida; print(frida.__version__)'
adb version
adb devices
adb shell getprop ro.product.cpu.abi
adb shell getprop ro.build.version.release
```

## 采集一轮问答

在项目根目录执行：

```bash
adb devices
./.venv-frida/bin/python tools/capture_complete_conversation.py --seconds 600
```

脚本自动建立 `tcp:27042` 转发。终端出现 `ready` 后，在 App 中新建对话并发送问题。等待回答和自动分享完成；出现 `capture_complete` 后读取输出文件，无需点击分享按钮。

默认输出目录为 `data/runtime/latest/`。每次启动会清空该目录下的三个同名文件。保留多次采集结果时，为每轮指定不同目录：

```bash
./.venv-frida/bin/python tools/capture_complete_conversation.py \
  --seconds 600 \
  --output-dir data/runtime/run-001
```

`--seconds` 是最长监听时间，成功取得分享响应后会提前结束。`--process` 可指定其他实际进程名。等待期间保持当前问答，避免发起第二条回答流或同时运行其他 Hook 脚本。

## 输出文件

| 文件 | 内容 |
|---|---|
| `complete_sse.log` | 本轮捕获的 SSE 文本，按行累积字节后以 UTF-8 解码，设备端落盘后拉回 |
| `complete_message.json` | 会话与消息 ID、问题、关键词、回答、引用、商品卡及分享链接 |
| `product_cards.json` | 会话与消息 ID、商品卡数量和独立商品卡列表 |

完整消息 JSON 的主要字段：

| 字段 | 含义 |
|---|---|
| `conversation_id` / `section_id` | 会话及 section 标识 |
| `message_ids` | SSE 中收集的消息 ID 列表 |
| `question` | 本轮发送的问题 |
| `keywords` | 搜索关键词 |
| `answer` | 解析合并后的回答正文 |
| `citations` | 引用网页标题和 URL |
| `product_cards` | 商品卡字段，包括商品、店铺、价格展示、图片、SKU 和跳转 schema 等实际返回信息 |
| `share` | `share_id`、`share_url`、`qr_code_url` |
| `sse_event_count` / `end_type` | 已解析事件数量及结束类型 |
| `encoding` | 输出编码，UTF-8 |

字段是否存在取决于 App 实际响应。商品价格展示中的 `?` 按响应原值保留。`product_detail_simple_url` 由商品 ID 拼接，不能视为已验证的实际跳转地址；统一入口未监听商品点击，`product_detail_url` 可能为空。

`message_ids` 按字符串保存，避免长整数在下游处理时损失精度。`citations` 的元素为 `title` 和 `url`。独立商品文件顶层包含 `conversation_id`、`message_ids`、`product_cards`、`product_card_count` 和 `encoding`，其中商品数组与完整消息文件中的商品数组一致。

商品对象保留解析取得的原始结构，常见字段包括 `pid`、`name`、`image/images`、`shop_info`、`price_info`、`sales_display`、`sell_points`、`sku_list` 和 `product_detail_schema`。字段并非每次全部返回，下游应按可选字段处理。生成的回答文本是解析结果，需要核查时以完整 SSE 为依据。

## 项目示例数据

以下文件是已完成采集的项目示例，固定保存在 `data/examples/newborn_formula/`，不作为临时测试数据清理，也不用于新一轮采集的输出目录：

| 示例文件 | 查看内容 |
|---|---|
| [complete_sse.log](data/examples/newborn_formula/complete_sse.log) | 完整 SSE 响应 |
| [complete_message.json](data/examples/newborn_formula/complete_message.json) | 问题、关键词、回答、引用、商品卡及分享链接 |
| [product_cards.json](data/examples/newborn_formula/product_cards.json) | 独立商品卡完整字段 |

可直接查看 JSON，或使用下列命令提取结构化内容，无需连接设备：

```bash
jq '{question, keywords, answer, citations, share}' data/examples/newborn_formula/complete_message.json
jq '.product_cards' data/examples/newborn_formula/product_cards.json
```

示例文件保留实际采集值，统计信息见文末实测快照。新采集写入 `data/runtime/`；需要长期保留的新示例应使用独立名称存入 `data/examples/`。清理运行数据时保留整个 `data/examples/` 目录。

## 完成判定与限制

自动分享在 SSE 顶层 `end_type=3` 后延迟 1.5 秒触发，`[DONE]` 保留为兜底。`end_type=1/2` 和内容块中的 `is_finish` 不触发分享。分享通过 App 内 `PreloadMessageShareHelper` 调用 `/im/message/share/save`。

运行结束后应检查问题和回答非空、`end_type=3`、`share.share_url` 非空，并按本轮内容核对引用和商品卡。`capture_complete` 表示文件生成完成，不代表所有业务字段必然齐全；分享失败也可能生成文件。

当前 Hook 使用单会话状态与固定设备日志路径，尚不支持并发问答。切换界面后旧回答流是否继续运行也需要单独验证。按 `conversation_id + request_id/stream_id` 隔离的方案已记录在技术文档，暂不实现。

超时、取消回答或手动中断时，数据可能不完整。脚本在捕获分享失败时结束等待；收到回答完成事件后最多再等待分享响应 30 秒，然后保存已捕获数据。Ctrl-C 会尝试保存已捕获数据。没有分享链接时，消息文件标记 `share_status=unavailable`；`capture_errors` 记录已捕获的错误。分享状态与回答完整性应分别检查。

App 的 `is_retry=1` 传输重试复用本轮会话上下文，并继续写入同一设备日志，避免截断前面的响应。完整日志可能包含重试事件，解析结果仍需核对。`ServerNotRunningError` 时检查设备端 frida-server、版本和端口转发；`target process is not running` 时先打开 App。

## 故障排查

| 现象 | 检查项 |
|---|---|
| 无法连接 Frida | `adb devices`、`adb forward tcp:27042 tcp:27042`、设备端服务和客户端版本 |
| 找不到进程 | App 是否运行，`--process` 是否与实际进程名称一致 |
| 未报告 SSE 日志路径 | 是否在 `ready` 后发送问题，Hook 是否成功安装，App 版本是否变化 |
| SSE 混入二进制乱码 | 核对 `read()` Hook 是否仅处理已登记的 `/chat/completion` 流对象；同一个输入流类也可能用于其他响应，不能仅按类名捕获。已出现替换字符的非文本数据不能靠切换编辑器编码恢复 |
| 分享页只有问题或回答不完整 | 是否捕获顶层 `end_type=3`，是否有第二条流覆盖当前状态 |
| `share` 为空 | 检查 `app_internal_share_api_error`、超时和分享响应事件 |
| 引用或商品数组为空 | 先核查本轮 SSE 是否实际返回对应内容，再检查解析字段是否变化 |
| 商品完整详情链接为空 | 统一入口未实现真实商品跳转监测；简化链接来自商品 ID |

## 维护与扩展

调整采集生命周期和文件输出时修改 `tools/capture_complete_conversation.py`；调整 App Hook 点、SSE 完成判断和分享调用时修改 `hooks/capture_message_share.js`；调整业务字段提取时修改 `tools/parse_android_sse.py`。

原始 APK 和反编译资料保留在 `device_work/`，用于 App 升级时核对类名、方法签名、请求模型和响应结构。它们不是采集脚本的运行依赖。现有示例可用于解析结果对照，但不能替代升级后的设备实测。

并发采集暂未实现。后续设计以 `conversation_id` 区分业务会话，以 `request_id/stream_id` 隔离同一会话内的请求，分别维护 SSE 缓冲区、完成状态、消息 ID、分享请求与回调。实施前还需验证新建对话是否会取消上一条回答流，并解决新会话 ID 尚未出现时的流绑定问题。设计详情见 [并发采集设计](docs/android_message_share_automation.md#并发采集设计暂不实现)。

## 技术说明

Hook 点、分享模型、响应捕获及待实现的并发设计见 [Android SSE 完成后自动生成对话分享链接](docs/android_message_share_automation.md)。

独立分享观察工具：

```bash
adb forward tcp:27042 tcp:27042
./.venv-frida/bin/python tools/capture_message_share.py --seconds 300
```

该工具输出 `data/runtime/message_share_capture.jsonl`，不生成完整采集入口的三个文件。

## 附录：验证记录

### 主机与工具环境快照

核实日期：2026-09-24。下表来自本机版本命令及项目文件；辅助工具版本用于复现分析环境，不是运行采集脚本的全部必装依赖。

| 项目 | 核实值 |
|---|---|
| 主机系统 | macOS 26.5.1，Build 25F80 |
| 主机架构 | arm64（Apple Silicon） |
| Python | 3.9.6，虚拟环境为 `.venv-frida` |
| Frida Python SDK | 16.7.19 |
| frida-tools | 13.7.1 |
| ADB | 1.0.41；Platform-Tools 37.0.1-15733141 |
| Apktool | 3.0.3；项目 `apktool.yml` 同样记录 3.0.3 |
| JADX | 1.5.6 |
| JDK | OpenJDK 27，Homebrew build 27 |
| Node.js | v26.9.0 |
| jq | jq-1.7.1-apple |

### 设备与 App 采集环境快照

核实日期：2026-09-24。以下设备信息来自本项目已成功采集时的 ADB 输出与 App 请求参数，未在本次文档整理中重新连接设备查询。

| 项目 | 实测记录 |
|---|---|
| 设备 | Android 模拟器，ADB 序列号 `emulator-5554` |
| 型号 | `sdk_gphone64_arm64`，请求参数记录为 Google 设备 |
| 系统 | Android 15 / API 35 |
| 目标 App | 豆包，包名 `com.larus.nova`，进程显示名称 `豆包` |
| App 版本 | 15.1.0；原始 APK 元数据 `versionCode=15010040` |
| Frida 连接 | `127.0.0.1:27042`，经 ADB 转发 |
| 设备端服务版本 | 本次未独立核实；已成功连接客户端 16.7.19，重新部署时须核对服务端版本 |

### 示例采集结果

核实日期：2026-09-24。Frida 客户端为 16.7.19，目标 App 版本为 15.1.0。单轮实测获得 124 条 SSE 事件、3 个关键词、17 条引用和 3 张商品卡，并在 `end_type=3` 后取得分享链接。此记录是样本快照，不是每轮采集的固定数量要求。

保留示例的问题为“新生儿奶粉推荐”，解析回答为 779 个字符；分享链接为 [查看示例对话](https://www.doubao.com/thread/xqgghiaPDjzp30SsH)。本地三个示例文件是固定采集快照，在线分享页的后续可用性由服务端决定。
