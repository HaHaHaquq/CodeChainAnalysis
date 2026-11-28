# ChainAnalysis v0.7.1 — 核心解析思路与实现方法文档

> 本文档专门聚焦 **ChainAnalysis v0.7.1** 后端分析引擎的**三阶段解析思路、工程元数据扫描方案、多重异步回调追踪算法与可选 `clangd` LSP 语义增强实现方法**。
> 工具整体功能与快速上手请参见 [README.md](./README.md)。

---

## 一、三阶段演进架构总览

ChainAnalysis 后端采用分层解耦的三阶段演进基座（位于 `src-tauri/src/`），上层图谱、泳道、WCS 栈深与移植清单完全独立于底层解析器升级：

```text
[阶段 1：工程上下文基座 project_db.rs]  ✅ 已完成
  统一归一化 compile_commands.json / Keil / IAR / Makefile(GCC) / 纯目录
  输出：ProjectModel（Target、真实源文件、IncludePath、Define 宏、排除编译清单）
        │
        ▼
[阶段 2：AST 语法与多重异步回调基座 c_ast.rs + callback_flow.rs]  ✅ 已完成
  tree-sitter-c 容错语法树 + 轻量 #ifdef 条件编译裁剪 + 跨函数多重异步回调数据流追踪
        │
        ▼
[阶段 3：可选 clangd LSP 语义增强层 clangd_bridge.rs]  ✅ 已完成
  利用阶段 1 生成的临时 compile_commands.json 驱动本机 clangd（有则增强，无则无感降级）
```

---

## 二、阶段 1：工程上下文解析方式（`src-tauri/src/project_db.rs`）

阶段 1 将不同 IDE 与构建系统的工程元数据统一抽象为内存结构 `ProjectModel`（等价于内存版编译数据库），按以下优先级自动探测与解析：

| 优先级 | 工程类型 | 解析方式 | 核心能力与避坑设计 |
| :---: | :--- | :--- | :--- |
| **1** | **GCC / CMake / Clang (`compile_commands.json`)** | `serde_json` + 引号感知 `shell_split` | 自动查找工程根目录及 `build/`、`out/`、`Debug/`、`Release/`、`cmake-build-*` 下的 `compile_commands.json`；支持 `arguments` 数组与 `command` 字符串，提取 `-I`/`-isystem`/`-iquote`、`-D`、源文件与编译器类型（`arm-none-eabi-gcc`、`gcc`、`clang` 等） |
| **2** | **Keil MDK (`.uvprojx` / `.uvproj`)** | **`roxmltree` 严格 XML 解析** | 以 `.uvprojx` 所在目录为基准解析相对路径（兼容放在 `MDK-ARM/` 子目录的工程）；按 `<Target>` 隔离多构建目标；读取 `TargetArmAds/Cads/VariousControls` 下的 `<IncludePath>` 与 `<Define>`；通过 `<uAC6>`/`<pCCUsed>` 区分 AC5 (`ARMCC`) 与 AC6 (`ARMCLANG`)；自动过滤 Group 与 File 级 `<IncludeInBuild>0</IncludeInBuild>` 的排除文件 |
| **3** | **IAR EWARM / RL78 (`.eww` / `.ewp`)** | **`roxmltree` 严格 XML 解析** | 先解析 `.eww` 工作区并展开 `$WS_DIR$` 关联全部 `.ewp`；按 `<configuration>/<name>` 隔离配置（优先 `Debug`）；展开 `$PROJ_DIR$` 读取 `CCIncludePath2`/`CCIncludePath`、`CCDefines`/`CCDefines2` 与 `<file><name>`；过滤当前配置下 `<excluded><configuration>` 排除的文件 |
| **4** | **GCC `Makefile` / `makefile`** | **纯静态变量求值器（无副作用）** | **不依赖本机 `make`，绝不执行 `make clean`**；静态处理 `\` 续行、`include *.mk`、`=`/`:=`/`+=`/`?=` 赋值、`$(VAR)` 递归展开与 `$(wildcard ...)` 静态 glob；兼容 STM32CubeMX 等 GCC Makefile 的 `C_SOURCES`/`C_INCLUDES`/`C_DEFS` 与 `arm-none-eabi-gcc` |
| **5** | **无工程文件的纯源码目录** | `WalkDir` 智能目录扫描兜底 | 保持对 CherryUSB、Zephyr、裸 C 组件库的 0 配置开箱即用 |

### 与分析流水线的联动
- **排除编译过滤**：IDE 中勾选排除的文件不会混入本地扫描、调用图或移植必拷文件闭包；
- **真实头文件闭包**：优先按当前文件目录与工程 `IncludePath` 解析 `#include`，再回退 basename 匹配；
- **工程宏注入**：将 Keil `<Define>` / IAR `CCDefines` / GCC `-D` 注入宏表与移植清单，同时为阶段 2 的 `#ifdef` 裁剪提供依据；
- **无污染临时编译数据库**：内置 `build_compile_commands()` 与 `write_temp_compile_commands()`（自动注入 AC5/AC6/IAR 兼容宏垫片，如 `__weak`/`__packed`/`__irq`/`__CC_ARM`/`__ICCARM__`），写入系统临时目录供阶段 3 `clangd` 复用，绝不改动用户仓库。

---

## 三、阶段 2：AST 解析与多重异步回调追踪（`c_ast.rs` + `callback_flow.rs`）

### 1. 源码解析方式（`src-tauri/src/c_ast.rs`）
- **保行号 `#ifdef` 死分支裁剪（`prune_inactive_ifdefs`）**：
  - 合并阶段 1 的工程构建宏（Keil `<Define>` / IAR `CCDefines` / GCC `-D`）与已加载头文件中的 `#define`；
  - 对 `#if 0` / `#if 1`、`#ifdef` / `#ifndef`、`#if defined(...)`、`==`/`!=`/`&&`/`||`/`!` 做轻量静态求值；
  - **关键设计**：被裁掉的死分支会被替换为空行而非删除，**严格保留 1-based 原始行号**，保证 Monaco 源码跳转行号完全不偏移；未知宏则保守保留，绝不误删业务代码。
- **`tree-sitter-c` 容错 AST 解析（`parse_c_file_ast`）**：
  - 使用 `tree-sitter` + `tree-sitter-c` 对裁剪后的 C 代码建语法树（无需安装编译器或系统标准库头文件也能毫秒级解析）；
  - 精准提取函数定义、完整多行条件嵌套栈（`switch` → `case` → `if` → `else`）、局部变量与数组栈帧估算、函数形参列表（含类型与函数指针形参）、结构化调用实参索引、间接函数指针调用点、槽位赋值与槽位拷贝。

### 2. 多重异步回调是如何解析的？（`src-tauri/src/callback_flow.rs`）

传统静态分析遇到多层封装注册（如 `app_init` → `drv_reg` → `hal_bind` → 存进全局结构体 → 中断触发）或“回调里再注册下一级回调”就会断链。阶段 2 采用**槽位归一化 + 不动点数据流传播（Fixed-Point Worklist Solver）**解决 4 类典型嵌入式异步回调：

1. **槽位归一化（`SlotKey`）**：把各种函数指针存储位置统一建模为 4 级精度的槽位键：
   - `StructField(Type, field)`（如 `uart_bus_t.rx_cb`，结合全局/形参/局部变量 AST 类型推导）
   - `VarField(var, field)`（如 `g_bus.rx_cb`、`rx_msg[ep].cb`）
   - `GlobalVar(var)`（如 `g_ep_slot[0]`、`g_rx_cb`）
   - `FieldOnly(field)`（低优先级兜底，且限制目标数防误连）
2. **种子收集（Hop 0）**：
   - 收集所有把已知函数作为实参传入的调用（记录 `(callee, arg_index) <- fn`）；
   - 收集所有直接赋值（`slot = fn`）以及局部/全局结构体指定初始化（`ep_cfg_t ep = { .ep_cb = app_ep_cb }`）。
3. **不动点多跳传播（最多 10 跳，毫秒级收敛）**：
   - **规则 A — 多层形参透传（`AstParamForward`）**：若函数 `A` 的第 `i` 个形参已流入目标函数 `F`，且 `A` 又把该形参传给 `B` 的第 `k` 个实参，则自动把 `F` 传播到 `(B, k)` 并追加传导路径 `... -> B`；
   - **规则 B — 形参写入槽位（`AstSlotWrite`）**：若 `B` 把第 `k` 个形参写入槽位 `S`（如 `g_bus.rx_cb = cb`），则把 `F` 绑定到槽位 `S`，完整记录多跳链路 `app_init -> drv_register -> hal_bind -> g_bus.rx_cb`；
   - **规则 C — 槽位间拷贝（`AstSlotCopy`，覆盖配置结构体转发模式）**：如 CherryUSB 风格的 `rx_msg[ep].cb = ep->ep_cb`，自动把源槽位 `ep.ep_cb` 中的回调传播到目标槽位 `rx_msg.cb`；
   - **嵌套/级联多重回调**：因为回调函数自身同样参与上述规则，若 Stage-1 回调 `app_on_rx_done` 内部又注册了 Stage-2 回调 `app_on_tx_done`，在同一轮不动点迭代中会自动同时解出两级中断触发链。
4. **触发点反查缝合（`INVOKE_CB`）**：
   - 在 ISR / 轮询 / 状态机中扫描所有直接形参调用 `cb(...)` 与间接槽位调用（`g_bus.rx_cb(...)`、`g_ep_slot[0](...)`、`huart->RxCpltCallback(...)`），按槽位精度从高到低反查绑定表，生成 `ASYNC_CALLBACK / INVOKE_CB` 边，并在 `registeredAt` 中完整标注**源码注册行 + 多跳传导路径**。

---

## 四、与 `keil2clangd (Keil2Json)` 工程扫描逻辑的设计对照

ChainAnalysis **没有外挂或拷贝 `keil2clangd` 的外部二进制/脚本**，而是在 Rust 端（`src-tauri/src/project_db.rs`）原生吸收了它的核心工程元数据扫描思路，并针对静态代码分析场景做了定向改进与取舍：

### 1. 吸收并原生实现的扫描逻辑
- **Keil `.uvprojx`**：解析 `<Target>` / `<TargetName>`、`<uAC6>` 与 `<pCCUsed>`（区分 AC5 / AC6）、`TargetArmAds/Cads/VariousControls` 下的 `<IncludePath>`（`;` 分隔）与 `<Define>`（`,` 分隔），以及 `<Groups>/<Group>/<Files>/<File>/<FilePath>`；
- **IAR `.eww` / `.ewp`**：展开 `.eww` 的 `$WS_DIR$` 关联全部 `.ewp`，解析 `<configuration>`、`<toolchain>`（ARM / RL78）、`CCIncludePath2`/`CCDefines` 与 `<file><name>`（展开 `$PROJ_DIR$`）；
- **`compile_commands.json` 生成**：输出标准 `directory`/`file`/`arguments`/`command` 及 IAR RL78 宏垫片。

### 2. 相比 `keil2clangd` 原版的避坑与增强
| 维度 | `keil2clangd` 原版现状 | ChainAnalysis 原生实现改进 |
| :--- | :--- | :--- |
| **相对路径基准** | 按命令行 `-p` 根目录解析，工程放在 `MDK-ARM/` 子目录时易失效 | 严格以 `.uvprojx` / `.ewp` 所在目录为基准解析 |
| **排除编译过滤** | 不过滤 Keil `<IncludeInBuild>0</IncludeInBuild>` 与 IAR `<excluded>` | 同时过滤 Group 与 File 级排除项，避免废弃驱动污染调用链与移植闭包 |
| **XML 解析稳健性** | C++ 版用正则提取 XML，且不支持 Keil4 `.uvproj` | 使用 `roxmltree` 严格 XML 解析，同时兼容 `.uvprojx` 与 `.uvproj` |
| **Makefile 安全性** | 依赖本机 `make`，会执行 `make clean && make -n`（修改工作区） | 纯静态变量展开与 `$(wildcard)` 求值，零外部命令、绝不改动用户工程 |
| **编译器宏垫片** | ARM 工具链仅注入 `-D__GNUC__` | 额外补齐 `__CC_ARM`、`__ARMCC_VERSION`、`__ICCARM__`、`__weak`、`__packed`、`__irq` 等垫片 |

### 3. 刻意取舍的两块逻辑
1. **本机注册表 / `TOOLS.INI` 探测系统头文件与 CMSIS 目录**：
   - 阶段 1/2 刻意不强依赖本机 Keil/IAR 安装环境（保证离线 0 配置打开任意开源仓库，且不让系统标准库稀释业务调用图）；
   - **已在阶段 3 中按需补齐**：仅在生成供 `clangd` 使用的临时 `compile_commands.json` 时，通过 `discover_host_system_includes()` 自动探测本机 Keil `TOOLS.INI`（`ARMCC/include`、`ARMCLANG/include`、`RTEPATH`/CMSIS）、IAR（`arm/inc/c`、`rl78/inc`）或 `arm-none-eabi-gcc` 系统头文件路径并以 `-isystem` 注入（未安装时安全忽略）。
2. **`UV4.exe` 编译/烧录/调试驱动（`--keil_build`）**：属于 IDE 构建器职责，不纳入 `ChainAnalysis` 分析引擎。

---

## 五、阶段 3：可选 `clangd` LSP 语义增强层（`src-tauri/src/clangd_bridge.rs`）

阶段 3 作为**可选的语义校准层**挂在阶段 2 之后，设计原则是“**有 `clangd` 时静默提精度，无 `clangd` 或超时时零报错无感降级到阶段 2**”：

1. **多源自动探测本机 `clangd`（`detect_clangd_binary`）**：
   - 依次探测：显式传入路径 / 环境变量 `CHAIN_ANALYSIS_CLANGD` → 系统 `PATH` → LLVM / MSYS2 / Homebrew 默认目录 → **VS Code / Cursor / Antigravity 扩展目录**（`llvm-vs-code-extensions.vscode-clangd/install/...`）。
2. **零污染临时编译数据库**：
   - 调用阶段 1 的 `write_temp_compile_commands()`，把包含工程 `-I`/`-D`、AC5/AC6/IAR 宏垫片以及本机系统/CMSIS `-isystem` 路径的 `compile_commands.json` 写到 `%TEMP%/chain_analysis_cdb/<hash>/`，绝不修改用户 Git 仓库。
3. **原生 LSP JSON-RPC 2.0 通信（`ClangdSession`）**：
   - 通过 `stdio` + `Content-Length` 帧协议拉起 `clangd --compile-commands-dir=<temp> --background-index=false --clang-tidy=false`；
   - 依次执行 `initialize` → `initialized` → `textDocument/didOpen` → `textDocument/prepareCallHierarchy` → `callHierarchy/outgoingCalls`；
   - 对每个单次请求与整轮增强设置严格超时预算（总预算 ≤ 6s），防止异常工程卡死 UI。
4. **语义增量补全与降级透明化**：
   - 将 `clangd` 通过完整预处理器与类型推导额外解析出的调用边（如多层宏包装展开的调用）补入调用图，标记为 `clangd 语义补全 (宏/类型推导)`；
   - 并在分析结果 `projectMeta` 及新增 IPC 命令 `get_clangd_status` 中返回 `clangdStatus`（`ACTIVE` / `UNAVAILABLE` / `FALLBACK`）、命中的二进制路径、补全边数与降级说明。



