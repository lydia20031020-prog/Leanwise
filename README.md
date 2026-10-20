# Leanwise Demo

可运行的中文 AI 减脂助手 Demo，含响应式网页、Express API 和微信原生小程序。按已确认范围，网页记录保存在当前浏览器，小程序记录保存在当前手机，不使用跨设备账号。网页首次加载包含可删除的示例数据。

## 发布和上线

- [腾讯云部署说明](deploy/README.md)：域名 `www.leanwise.lydiaowo.com`，服务器 `43.143.208.73`，含安装、密钥配置、更新、回滚与验收命令。
- [微信小程序说明](miniprogram/README.md)：AppID `wx5971d92eb86b0234`，开发者工具导入、合法域名配置和预览上传。
- GitHub 仓库：<https://github.com/lydia20031020-prog/Leanwise>。

本机发布脚本会检查生成文件和密钥，使用 GitHub 账户登录后推送，不需要将密码或 Token 放入源码：

```powershell
cd C:\Users\tairan.xu\Desktop\AIPM\Leanwise
powershell -NoProfile -ExecutionPolicy Bypass -File .\publish-github.ps1
```

## 启动

需要 Node.js 22.12 或更新版本。

```powershell
cd C:\Users\tairan.xu\Desktop\AIPM\Leanwise
npm.cmd install
npm.cmd run dev
```

打开 http://127.0.0.1:5173 。API 位于 http://127.0.0.1:8787 。

也可双击 `start-demo.cmd` 启动。已经运行时无需重复启动。

生产构建：

```powershell
npm.cmd run build
npm.cmd start
```

生产页面与 API 共用 http://127.0.0.1:8787 。

## DeepSeek 配置

在项目 `.env` 内配置，参考 `.env.example`。密钥不会发送到浏览器，不要放在 `VITE_` 变量中或提交到版本库。

```dotenv
DEEPSEEK_API_KEY=your_api_key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-flash
PORT=8787
```

采用官方 OpenAI JavaScript SDK 的 `chat.completions.create`，保持 `stream:false`、`reasoning_effort:high` 和 `thinking:{type:enabled}`；JavaScript 中自定义参数直接放入请求体，等价于 Python 的 `extra_body`。

Python 示例中的 `os.environ.get(...)` 参数应是 `DEEPSEEK_API_KEY` 这样的环境变量名，不能填写密钥值。

修改 `.env` 后重启 API。配置状态只说明密钥已填入，不代表认证、模型权限或余额正常。实际测试中 `deepseek-flash` 文字食品解析与真实数据顾问均已成功返回；图片请求被拒绝，因此拍照自动识别仍需支持视觉的模型接口。不会自动切换模型，也不会将失败包装为成功识别。

## 已实现

- 今日预算、营养进度、餐食明细，所有页面共享确定性计算。
- 相机/相册照片留档、文字说明，AI 文字分项草稿与逐项编辑；照片不发送给当前不支持视觉的模型。
- 食品营养基准纠正并记忆；本次份量独立保存；常用配方复用。
- 个人食品库透明解析与手动添加，均明确不是 AI 识别。
- 历史补记、编辑、删除、记录完整标记。
- 体重记录与滚动趋势、目标和个人资料编辑。
- AI 顾问获取当前真实记录、目标、完整状态和消耗来源；本地数据摘要另行标注。
- 小米/华为演示同步、主要来源选择、消耗/估算视图切换，模拟样本始终有标识。
- 本地持久化、导出、清空、重新加载示例。

## 推荐体验

1. 记录页输入“咖啡牛奶 + 一个鸡蛋”，点击“用个人食品库解析”。
2. 修改牛奶份量为 200 ml，展开营养基准，将每 240 ml 热量改为 192 kcal，确认保存。
3. 食物记忆中再次使用“咖啡牛奶”：份量仍为常用 150 ml，新营养基准是 192 kcal。
4. 修改历史餐食，确认今日与历史同步更新；过去记录不因食品库变动而自动改写。
5. 记录新体重，查看趋势；健康数据页刷新模拟数据并切换来源，预算保持不变。
6. AI 配置有效后向顾问提问。尚未配置或调用失败时，可查看本地数据摘要。

## 边界

- 这是浏览器 Demo，不是 Android 原生包。实际厂商账户授权需要官方资格及接入审批，本项目未伪造真实授权。
- 按当前确认的交付范围，保留拍照上传、文字补充和手动核对。AI 按文字说明和食品记忆生成草稿，原图本机留档；自动视觉识别留待支持图片的接口接入。
- 设备日常活动热量不等于全天总消耗，首版切换消耗视图不会自动抬高当天预算。
- 数据仅保存在当前浏览器或当前手机，网页与小程序各自保存。相片压缩后本地保存，存储失败会提示备份。浏览器清理缓存、换浏览器、换手机或卸载小程序可能丢失本机记录，请使用导出备份。
- 目标由用户确认，Demo 不自动开具医疗营养方案或预测精确达标日期。

## 验证

```powershell
npm.cmd test
npm.cmd run build
```

测试覆盖营养换算、记忆与份量隔离、旧快照、品牌替换、记录完整状态、来源选择、存储异常、服务端数据校验、记忆防篡改、失败状态、真实上下文与模拟连接标识。

技术栈：React / TypeScript / Vite、Recharts、Express、OpenAI SDK。API 详细契约见 [server/README.md](server/README.md)。
