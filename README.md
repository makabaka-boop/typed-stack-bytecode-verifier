# vmcheck —— 设备控制脚本 JSON 命令行校验器

对设备控制脚本（栈式字节码，JSON 指令数组）做**运行前静态校验**：按控制流传播
“完整的栈类型序列”，保证任何一条可达分支都不会把布尔当数字相加、不会让循环
不断抬高栈深，也不会下溢、越界跳转或从末尾跌出。

## 指令集

程序是 1～500 条指令的 JSON 数组，从 PC 0、空栈开始执行：

| 指令 | 语义 | 栈型要求 |
| --- | --- | --- |
| `{"op":"PUSH","value":v}` | 整数/布尔常量入栈 | 深度 < 32 |
| `{"op":"ADD"}` | 两整数相加 | 栈顶两项均为 `INT` |
| `{"op":"EQ"}` | 比较同类型两值，产生布尔 | 栈顶两项类型相同 |
| `{"op":"NOT"}` | 布尔取反 | 栈顶为 `BOOL` |
| `{"op":"DUP"}` / `{"op":"POP"}` | 复制/丢弃栈顶 | 栈非空（DUP 深度 < 32） |
| `{"op":"JUMP","target":t}` | 绝对地址跳转 | `0 <= t < 指令数` |
| `{"op":"JUMP_IF_FALSE","target":t}` | 弹出栈顶布尔，为假跳 `t`，为真顺序执行 | 栈顶为 `BOOL`，目标合法 |
| `{"op":"HALT"}` | 停机 | 栈上恰有一个 `BOOL` |

最大允许栈深 **32**。

## 校验规则

- **抽象域是完整栈型序列**（栈底→栈顶的 `INT`/`BOOL` 列表），不是深度计数。
  同一 PC 的不同入边若产生不同序列即报 `CONFLUENCE` 合流错误——循环每轮净增
  栈槽、分支两侧栈型不一致都会被精确捕获；序列相同则合流，分析保证终止。
- 可达路径上的下溢、类型错误、栈深超限、越界跳转、末尾跌出、HALT 栈型不对
  一律拒绝；**死代码（含其中的坏指令、越界跳转）只列入 `deadCode`，不触发错误**。
- 成功时输出每个可达 PC 的入栈签名与全局最大栈深；失败时输出结构化错误与
  **实际控制流见证**（从 PC 0 到出错点的逐帧路径，含每帧入栈类型与分支标注）。

## 使用

```bash
npm install
npm run build

node dist/cli.js samples/ok.json            # 文件输入
cat program.json | node dist/cli.js         # 标准输入
```

退出码：`0` 通过；`1` 控制流/栈校验失败；`2` 用法或结构错误（非法 JSON、
指令数不在 1..500）。结果 JSON 打到 stdout。

### 输出示例（失败）

```json
{
  "ok": false,
  "error": {
    "code": "CONFLUENCE",
    "message": "同一 PC 的不同入边产生了不同的栈类型序列（合流错误）",
    "pc": 1,
    "stackAtEntry": ["BOOL", "BOOL", "INT"],
    "existingStack": ["BOOL"],
    "incomingStack": ["BOOL", "BOOL", "INT"],
    "witness": { "frames": [ { "pc": 0, "stackAtEntry": [], "op": "PUSH" } ] }
  },
  "reachable": [0, 1, 2, 3, 6, 4, 5],
  "deadCode": []
}
```

错误码：`BAD_INSTRUCTION` / `UNDERFLOW` / `TYPE_MISMATCH` / `STACK_OVERFLOW` /
`JUMP_OUT_OF_BOUNDS` / `FALL_OFF_THE_END` / `BAD_HALT_STACK` / `CONFLUENCE`。

## Docker Compose（vmcheck 服务，同一入口）

```bash
docker compose build vmcheck
docker compose run --rm vmcheck samples/ok.json
docker compose run --rm vmcheck samples/bad-loop-grows.json
cat program.json | docker compose run --rm -T vmcheck
docker compose run --rm --entrypoint npm vmcheck test   # 镜像内跑测试
```

## 测试（Vitest 对拍）

```bash
npm test
```

- `test/analyzer.test.ts`：定向用例——分支合流（一致/深度不同/类型不同）、
  循环增栈、栈深 32 边界、越界跳转、末尾跌出、死代码、坏指令可达性、见证形状。
- `test/differential.test.ts`：**对拍**。`src/testing/oracle.ts` 是独立参考实现
  （元组 IR + 独立编码器 + BFS 枚举所有可达 `(PC, 栈型)` 抽象状态，合流仅在
  序列完全相同时发生）。数千个随机小程序逐一比较：ok/错误码与出错 PC、每个
  可达 PC 的入栈签名、最大栈深、可达集。
- `test/cli.test.ts`：CLI 退出码与 stdout JSON。

## 代码结构

```
src/types.ts      类型与常量（MAX_STACK=32、错误码、见证结构）
src/decode.ts     JSON 解析与宽解码（坏指令延迟到可达性判定）
src/analyzer.ts   控制流分析：工作流遍历 (PC, 完整栈型)，合流检测，见证生成
src/cli.ts        命令行入口（Docker 同一入口）
src/testing/oracle.ts  独立参考实现（仅测试用）
samples/          示例程序
```
