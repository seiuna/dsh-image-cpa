# dsh-cpa-image

让 DeepSeek Harness（DSH）的主代理通过 CLIProxyAPI（CPA）调用图片模型：生成真实图片、按参考图编辑、把原图存到工作区，并在对话里直接显示。

主模型和图片模型是两条独立的路由。主代理仍然是你的文本模型（例如 DeepSeek），图片模型是 CPA 背后的 `gpt-image-2`；这个插件不会为了生图切换主模型，也不会另建一个图片子代理。

```text
DSH 主代理 → cpa_image_generate / cpa_image_edit → CpaClient(HTTP) → CLIProxyAPI → Codex OAuth → 图片模型
                                                                      ↓
                                          保存原图到工作目录 generated-images/
                                          注册为 DSH 持久附件 → 对话内预览
```

## 环境

- DSH Desktop `0.2.2-rc.1`（Web GUI），Cordis `4.1.0`
- 插件运行在 Host 侧（Node），不依赖浏览器直连 CPA
- CLIProxyAPI `0.2.72`（本机验证版本），`http://127.0.0.1:8317/v1`

## 安装（Windows）

插件是一个普通的 DSH bundle，安装方式是把它作为一个 profile 依赖接进去。

1. 构建：

```powershell
pnpm install
pnpm run build      # 产物在 lib/：Host 用 lib/index.js，浏览器用 lib/client.js
```

2. 在 `C:\Users\<你>\.dsh\profiles\desktop\package.json` 里加依赖和 bundle：

```json
{
  "dependencies": {
    "dsh-cpa-image": "link:D:/project/dsh-image-cpa"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-cpa-image"]
    }
  }
}
```

3. 让 profile 解析到这个包（pnpm 的 `link:` 安装，或直接建 junction）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-cpa-image" `
  -Target "D:\project\dsh-image-cpa"
```

4. 在 DSH 里启用：设置 → 插件，或在会话里让代理调用 `plugin_manager` 把 `dsh-cpa-image` 设为 enabled。Host 侧的工具注册会立刻生效。

5. **浏览器侧的图片卡片需要重启 DSH 应用**：客户端插件在页面启动时组装，热重载只覆盖 Host。重启后新的工具卡片才会用上 `lib/client.js`。

### 卸载

```powershell
# 1. 在 DSH 设置里禁用 dsh-cpa-image，或从 bundles 列表移除
# 2. 删除依赖与链接
Remove-Item "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-cpa-image"
#   并从 profile package.json 的 dependencies / bundles 移除 "dsh-cpa-image"
```

已生成的图片和已注册的附件不会被删除（见“已知限制”）。

## 配置

配置通过 bundle 的 row config 提供，写在 profile 的 `cordis.patch.yml` 里，例如：

```yaml
- id: cpa-image
  config:
    baseUrl: 'http://127.0.0.1:8317/v1'
    model: gpt-image-2
    timeoutMs: 180000
```

| 配置 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不注册任何工具 |
| `baseUrl` | `http://127.0.0.1:8317/v1` | 只接受 http/https，禁止把凭据写进 URL |
| `apiKeyEnv` | `CPA_API_KEY` | **凭据名**，不是密钥；从 DSH 凭据服务读取，回退到启动环境 |
| `model` | `gpt-image-2` | 默认图片模型 |
| `defaultSize` | `1024x1024` | 请求尺寸；实际尺寸以返回的图片为准 |
| `timeoutMs` | `180000` | 单次请求超时；超时不重试 |
| `maxConcurrent` | `1` | 同时进行的 CPA 请求上限 |
| `outputDir` | `generated-images` | 相对路径以会话工作目录为基准，不能逃出工作目录 |
| `imageEditing` | `auto` | `auto` / `on` / `off`；`off` 时 `cpa_image_edit` 直接报不可用 |
| `maxImagesPerRequest` | `4` | `n` 的上限 |
| `maxImageBytes` | `25165824` | 单张图片字节上限 |
| `quality` | 空 | 留空则不向上游传 `quality` |

密钥一律不落盘、不写日志、不进工具结果。插件只报告“有没有配置”，不打印值。

## 工具

### `cpa_image_generate`

| 参数 | 类型 | 说明 |
|---|---|---|
| `prompt` | string | 必填，提示词 |
| `model` | string | 可选，覆盖默认模型 |
| `size` | string | 可选，如 `1024x1024` |
| `n` | integer | 可选，默认 1，上限 `maxImagesPerRequest` |
| `quality` | string | 可选，仅在上游支持时传递 |
| `output_name` | string | 可选，文件名（不含目录），不覆盖已有文件 |

返回结构化值：`model`、`images[]`（`filePath`、`fileName`、`mimeType`、`width`、`height`、`bytes`、`attachment`）、可选的 `revisedPrompt` 与 `note`。

### `cpa_image_edit`

| 参数 | 类型 | 说明 |
|---|---|---|
| `prompt` | string | 必填，编辑要求 |
| `image_path` | string | 可选，参考图路径，必须位于会话工作目录或输出目录内 |
| `attachment_id` | string | 可选，当前会话里出现过的 DSH 图片附件 |
| `mask_path` | string | 可选，蒙版，尺寸必须与参考图一致 |
| `model` | string | 可选 |
| `size` | string | 可选 |

`image_path` 与 `attachment_id` 至少给一个。附件 ID 只会解析到本会话已记录的图片引用，模型无法凭空构造一个内部 ID。

### `cpa_image_status`

只读诊断：`/models` 是否可达、认证是否通过、当前模型是否在目录里、生成与编辑路由是否挂载、输出目录落在哪里。它**不发提示词**，因此不会消耗额度。

## 图片落地

1. 解码 `data[].b64_json`，拒绝非规范 base64 与空数据。
2. 用魔数确认真实格式（PNG/JPEG/WebP/GIF），不信声明。
3. 从容器头读真实宽高（请求尺寸不作数）。
4. 校验字节数、单边尺寸、总像素。
5. 原子写入（临时文件 + rename），同名不覆盖，自动加 `-1`。
6. 注册到 `ctx.attachments`，得到 `sha256:` 形式的持久引用；会话事件只带引用，不带 base64。
7. 工具结果同时给出绝对路径与附件引用，并把 image block 渲染进对话。

生成目录默认是 `<会话工作目录>/generated-images/`，文件名形如 `20261106-182340-f55ac4.png`。

## 错误处理

| 情况 | 行为 |
|---|---|
| CPA 未启动 | `CONNECT_FAILED`，报文带 baseUrl 与 `ECONNREFUSED`，不重试 |
| 密钥无效 | `AUTH`，提示去 DSH 凭据里检查 |
| 模型不存在 | `MODEL_NOT_FOUND` / `UPSTREAM_ERROR`，回显上游原始说明 |
| 429 | 区分 `QUOTA_EXCEEDED` 与 `RATE_LIMITED` |
| 超时 | `TIMEOUT`，绝不自动重试（避免重复扣额度） |
| 用户取消 | 透传 `AbortSignal`，报 `ABORTED` |
| 非 JSON / 空 data / 只有 URL | `INVALID_JSON` / `UNSUPPORTED_RESPONSE`，不下载远程 URL（防 SSRF） |
| 非图片字节或损坏 | 校验失败，不写文件 |
| 写入失败 | `WRITE_FAILED`，不谎报成功 |
| 编辑不被支持 | `UNSUPPORTED_EDIT`，明确说不可用 |

## 安全边界

- 密钥只经 `ctx.credentials.resolve()` 或环境变量取得，从不写日志、不进错误文本；上游报错先做 redaction。
- 只请求配置里的 `baseUrl`，不跟随重定向，不请求响应里出现的 URL。
- 本地参考图先 `realpath` 再判断是否在授权根目录内，符号链接逃逸会被拒绝。
- `output_name` 只当叶子文件名处理，分隔符、控制字符、Windows 设备名一律拒绝。
- 每次调用单发不重试；并发由信号量限制在 `maxConcurrent`。

## 已知限制

- **CPA `0.2.72` 忽略 `n` 与 `response_format`**：它只读 `model`/`prompt`/`size`/`quality`，固定内联返回 base64。插件因此不发 `response_format`，`n>1` 也照发但会在结果里如实说明“请求 N 张、上游只回 M 张”。
- **实际尺寸由上游决定**：请求 `1024x1024`，本次实测拿到 `1312x1199`，插件记录的是真实尺寸。
- **蒙版只做了上传与尺寸一致性校验**，本机没有对 `/images/edits` 的 mask 语义做端到端验证。
- **`attachment_id` 依赖会话投影**：只解析当前会话里已记录过的图片引用；重启后旧会话的附件对象仍在，但需要该会话被恢复才可见。
- **浏览器图片卡片需要重启 DSH** 才会加载 `lib/client.js`；Host 工具本身热重载即可。
- 附件对象不会被自动清理（DSH 当前策略）。

## 开发

```powershell
pnpm install
pnpm run typecheck   # Host + 浏览器两套 tsconfig
pnpm test            # vitest，69 个用例，全部走假 HTTP，不消耗额度
pnpm run build       # Host(tsc) + 浏览器(esbuild 包装成 __ModuleLoader__ bundle)
```

目录：

```text
src/index.ts            插件生命周期与工具注册
src/config.ts           schemastery 配置、校验、运行时视图
src/client/cpa-client.ts CPA HTTP、响应解析、路由探测
src/client/cpa-errors.ts 错误码、分类、redaction
src/tools/generate.ts   文生图工具
src/tools/edit.ts       图片编辑工具
src/tools/status.ts     只读诊断工具
src/tools/shared.ts     运行时上下文、输出 schema、落盘流程
src/image/validate.ts   魔数、宽高、base64、限额
src/image/storage.ts    路径边界、原子写、唯一命名
src/image/attachment.ts 附件注册、会话内附件解析、image block
src/ui/index.ts         浏览器侧工具卡片（复用 tool.call.images 画廊）
```

## 验收记录（本机实测）

| 场景 | 结果 |
|---|---|
| A 直接生成 | `cpa_image_generate` 实调 CPA，得到 `1312x1199` PNG，存为 `generated-images/20261106-182340-f55ac4.png`，注册为 `sha256:3651…` 附件并在对话里显示 |
| B 主模型独立 | 图片请求直接打 CPA，与主对话模型无耦合；工具结果只经工具通道返回 |
| C 修改图片 | `cpa_image_edit` 以本地参考图调用 `/images/edits`，返回黄昏海边版本 `generated-images/20261106-182751-250c07.png`（`sha256:84e1…`） |
| D 服务异常 | 把 `baseUrl` 指向 `127.0.0.1:8399` 后：`cpa_image_status` 报 `CONNECT_FAILED/ECONNREFUSED`，`cpa_image_generate` 直接报错，不崩溃、不产假图、不重试 |
| E 重启持久化 | 附件对象已写入 `~/.dsh/attachments/v1/objects/…`，原图在 `generated-images/`；重启后的会话复用同一引用（重启本身需你操作验证） |

## License

MIT
