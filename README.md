# vmcheck 栈机 JSON 校验器

这是一个 TypeScript/Node.js 命令行校验器，用于在执行设备控制脚本前做静态控制流检查。它会从 PC 0 的空栈出发，沿所有可达控制流边传播**完整的栈类型序列**，而不是只传播栈深度。

## 输入格式

输入可以是 `{ "instructions": [...] }` 包装对象，也可以直接是顶层指令数组；指令数量为 1～500。包装对象格式：

```json
{
  "instructions": [
    { "op": "PUSH_BOOL", "value": true },
    { "op": "HALT" }
  ]
}
```

也可以写成：

```json
[
  { "op": "PUSH_BOOL", "value": true },
  { "op": "HALT" }
]
```

支持的指令：

| 指令 | 操作数 | 栈语义 |
| --- | --- | --- |
| `PUSH_INT` | `value: integer` | 压入 `int` |
| `PUSH_BOOL` | `value: boolean` | 压入 `bool` |
| `ADD` | 无 | 弹出两个 `int`，压入一个 `int`；布尔值不能当数字相加 |
| `EQ` | 无 | 弹出两个同类型值，压入一个 `bool` |
| `NOT` | 无 | 弹出一个 `bool`，压入一个 `bool` |
| `DUP` | 无 | 复制栈顶 |
| `POP` | 无 | 弹出栈顶 |
| `JUMP` | `target: integer` | 绝对地址跳转，目标必须在程序范围内 |
| `JUMP_IF_FALSE` | `target: integer` | 弹出一个 `bool`；真分支落到下一条，假分支跳到 `target` |
| `HALT` | 无 | 停机；此时栈必须恰好有一个 `bool` |

校验规则：

- 最大允许栈深为 32。
- 每个可达 PC 只能有一个入栈类型序列；不同入边产生不同序列时报 `stack_merge_conflict`。
- 可达的下溢、类型错误、越界跳转、栈溢出、非法 HALT 栈和末尾跌出都会使程序无效。
- 不可达指令只列入 `deadPcs`，即使格式错误也不会触发校验错误。
- 分析只跟踪类型，不跟踪具体布尔值，因此 `JUMP_IF_FALSE` 的两个分支都会按可达处理。
- 固定栈状态的循环是允许的；不断改变栈类型序列的循环会在回边合流时被拒绝。

## 本地运行

```bash
npm install
npm run build
node dist/cli.js examples/valid.json
# 或从 stdin 读取
node dist/cli.js < examples/valid.json
```

退出码：

- `0`：程序有效；
- `1`：JSON、输入结构或可达控制流校验失败；
- `2`：命令行参数或文件读取错误。

成功输出包含每个可达 PC 的入栈签名和最大栈深，例如：

```json
{
  "ok": true,
  "kind": "program",
  "instructionCount": 2,
  "analysis": {
    "valid": true,
    "status": "valid",
    "reachablePcs": [0, 1],
    "deadPcs": [],
    "pcSignatures": {
      "0": [],
      "1": ["bool"]
    },
    "maxStackDepth": 1,
    "issues": []
  }
}
```

失败输出包含 `issues`。每个 issue 都带有从 PC 0 出发的实际控制流见证：

- 普通操作错误：`witness.path` 加 `witness.attempted`；
- 越界跳转：`witness.attempted.type === "jump"`；
- 末尾跌出：`witness.attempted.type === "fall_through"`；
- 合流冲突：`witness.conflicts` 同时包含两条入边的栈序列和完整路径。

## Docker Compose

`vmcheck` 服务使用同一个 CLI 入口：

```bash
docker compose build vmcheck
docker compose run --rm vmcheck /app/examples/valid.json
docker compose run --rm -T vmcheck < examples/valid.json
```

校验失败时 Compose 命令返回退出码 1；成功时返回 0。

## 测试

```bash
npm test
```

Vitest 覆盖：

- 分支合流成功与 `stack_merge_conflict`；
- 回边不断增栈的循环；
- 不可达坏指令只列入 `deadPcs`；
- 栈深 32 的边界和第 33 项溢出；
- 越界跳转、末尾跌出、下溢、类型错误和 HALT 栈约束；
- 对 8 个直线指令生成全部 1～4 长度小程序（共 4680 个），与独立参考抽象状态枚举器逐项对拍；
- CLI 文件输入、stdin 输入和退出码。
