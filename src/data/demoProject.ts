import { ProjectAnalysis } from "../types/analysis";

const FILES: Record<string, string> = {
  "app/app_ota_task.c": `/**
 * @file app_ota_task.c
 * @brief FreeRTOS Ymodem OTA 升级业务任务入口
 */
#include "FreeRTOS.h"
#include "task.h"
#include "semphr.h"
#include "ymodem_core.h"
#include "bsp_uart_dma.h"
#include "bsp_flash_ops.h"

SemaphoreHandle_t g_ota_rx_sem = NULL;
static uint8_t g_ota_status = 0;

void App_OTA_Init(void) {
    g_ota_rx_sem = xSemaphoreCreateBinary();
    /* 注册串口接收异步回调：底层中断收到数据后触发 On_Ymodem_Rx_Byte */
    BSP_UART_RegisterRxCallback(On_Ymodem_Rx_Byte);
    /* 绑定 Flash 驱动操作接口表 (Ops Table) */
    Ymodem_BindFlashOps(&g_stm32_flash_ops);
    xTaskCreate(vYmodemOtaTask, "OTA_Task", 512, NULL, 3, NULL);
}

void vYmodemOtaTask(void *pvParameters) {
    (void)pvParameters;
    ymodem_ctx_t ctx = {0};

    BSP_UART_Init(115200);
    g_ota_status = 1;

    for (;;) {
        /* 阻塞等待 ISR 回调释放信号量，或 1000ms 超时重试握手 */
        if (xSemaphoreTake(g_ota_rx_sem, pdMS_TO_TICKS(1000)) == pdTRUE) {
            int ret = Ymodem_Receive_FSM(&ctx);
            if (ret == YMODEM_DONE) {
                g_ota_status = 2;
                HAL_NVIC_SystemReset();
            }
        } else {
            Ymodem_Send_Handshake();
        }
    }
}
`,
  "middleware/ymodem_core.h": `#ifndef __YMODEM_CORE_H__
#define __YMODEM_CORE_H__

#include <stdint.h>
#include <stddef.h>

#define YMODEM_PACKET_1K_SIZE   1024
#define YMODEM_MAX_ERRORS       10
#define YMODEM_USE_CRC16        1

typedef struct {
    int (*erase)(uint32_t addr, uint32_t len);
    int (*write)(uint32_t addr, const uint8_t *data, uint32_t len);
} flash_ops_t;

typedef struct {
    uint8_t state;
    uint8_t seq;
    uint32_t write_addr;
    uint32_t total_size;
    uint16_t err_cnt;
} ymodem_ctx_t;

void Ymodem_BindFlashOps(const flash_ops_t *ops);
void Ymodem_Send_Handshake(void);
int  Ymodem_Receive_FSM(ymodem_ctx_t *ctx);
void On_Ymodem_Rx_Byte(uint8_t byte);

#endif
`,
  "middleware/ymodem_core.c": `/**
 * @file ymodem_core.c
 * @brief Ymodem-1K 协议核心状态机与数据包解析（目标移植核心）
 */
#include "ymodem_core.h"
#include "ringbuf.h"
#include "bsp_uart_dma.h"

static const flash_ops_t *s_flash_ops = NULL;
extern SemaphoreHandle_t g_ota_rx_sem;

void Ymodem_BindFlashOps(const flash_ops_t *ops) {
    s_flash_ops = ops;
}

void On_Ymodem_Rx_Byte(uint8_t byte) {
    /* 运行在中断上下文：零阻塞写入环形缓冲区，并唤醒 OTA 任务 */
    RingBuf_Put(&g_uart_ringbuf, byte);
    BaseType_t woken = pdFALSE;
    xSemaphoreGiveFromISR(g_ota_rx_sem, &woken);
}

void Ymodem_Send_Handshake(void) {
    uint8_t ch = 'C';
    HAL_UART_Transmit(&huart1, &ch, 1, 50);
}

int Ymodem_Receive_FSM(ymodem_ctx_t *ctx) {
    uint8_t head = 0;
    if (RingBuf_Get(&g_uart_ringbuf, &head) != 0) {
        return YMODEM_BUSY;
    }

    switch (ctx->state) {
        case YM_STATE_WAIT_HEAD:
            if (head == STX || head == SOH) {
                ctx->state = YM_STATE_RECV_DATA;
                return Ymodem_Parse_Packet(ctx, head);
            }
            break;
        case YM_STATE_RECV_DATA:
            return Ymodem_Parse_Packet(ctx, head);
        case YM_STATE_EOT:
            ctx->state = YM_STATE_DONE;
            return YMODEM_DONE;
        default:
            ctx->state = YM_STATE_WAIT_HEAD;
            break;
    }
    return YMODEM_OK;
}

int Ymodem_Parse_Packet(ymodem_ctx_t *ctx, uint8_t head) {
    /* ⚠️ 高危局部大数组：在任务栈上直接分配 1024 + 256 字节！ */
    uint8_t pkt_buf[YMODEM_PACKET_1K_SIZE];
    uint8_t dec_buf[256];
    uint16_t rx_crc = 0;
    uint32_t pkt_len = (head == STX) ? 1024 : 128;

    for (uint32_t i = 0; i < pkt_len; i++) {
        RingBuf_Get(&g_uart_ringbuf, &pkt_buf[i]);
    }

    uint16_t calc_crc = Ymodem_Calc_CRC16(pkt_buf, pkt_len);
    if (calc_crc != rx_crc) {
        ctx->err_cnt++;
        return YMODEM_ERR_CRC;
    }

    /* 通过函数指针接口表写入 Flash，实现与具体芯片解耦 */
    if (s_flash_ops && s_flash_ops->write) {
        s_flash_ops->write(ctx->write_addr, pkt_buf, pkt_len);
        ctx->write_addr += pkt_len;
    }
    (void)dec_buf;
    return YMODEM_OK;
}

uint16_t Ymodem_Calc_CRC16(const uint8_t *buf, uint32_t len) {
    uint16_t crc = 0;
    for (uint32_t i = 0; i < len; i++) {
        crc ^= ((uint16_t)buf[i] << 8);
        for (int b = 0; b < 8; b++) {
            crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
        }
    }
    return crc;
}
`,
  "middleware/ringbuf.c": `/**
 * @file ringbuf.c
 * @brief 无锁单生产者/单消费者环形缓冲区
 */
#include "ringbuf.h"

ringbuf_t g_uart_ringbuf;

int RingBuf_Put(ringbuf_t *rb, uint8_t data) {
    uint16_t next = (rb->head + 1) & (RINGBUF_SIZE - 1);
    if (next == rb->tail) {
        return -1; /* buffer full */
    }
    rb->buf[rb->head] = data;
    rb->head = next;
    return 0;
}

int RingBuf_Get(ringbuf_t *rb, uint8_t *out) {
    if (rb->head == rb->tail) {
        return -1; /* buffer empty */
    }
    *out = rb->buf[rb->tail];
    rb->tail = (rb->tail + 1) & (RINGBUF_SIZE - 1);
    return 0;
}
`,
  "drivers/bsp_uart_dma.c": `/**
 * @file bsp_uart_dma.c
 * @brief STM32 HAL 串口与中断回调适配层（移植需替换）
 */
#include "bsp_uart_dma.h"

typedef void (*uart_rx_cb_t)(uint8_t byte);
static uart_rx_cb_t s_rx_callback = NULL;
static uint8_t s_dma_rx_byte = 0;

void BSP_UART_RegisterRxCallback(uart_rx_cb_t cb) {
    s_rx_callback = cb;
}

void BSP_UART_Init(uint32_t baudrate) {
    huart1.Init.BaudRate = baudrate;
    HAL_UART_Init(&huart1);
    HAL_UART_Receive_IT(&huart1, &s_dma_rx_byte, 1);
}

void USART1_IRQHandler(void) {
    HAL_UART_IRQHandler(&huart1);
}

/* 强函数重写 STM32 HAL 库的 __weak HAL_UART_RxCpltCallback */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart) {
    if (huart->Instance == USART1) {
        if (s_rx_callback != NULL) {
            s_rx_callback(s_dma_rx_byte);
        }
        HAL_UART_Receive_IT(&huart1, &s_dma_rx_byte, 1);
    }
}
`,
  "drivers/bsp_flash_ops.c": `/**
 * @file bsp_flash_ops.c
 * @brief STM32F4 内部 Flash 驱动操作接口表（移植需替换为目标 MCU Flash API）
 */
#include "bsp_flash_ops.h"

int BSP_Flash_Erase(uint32_t addr, uint32_t len) {
    HAL_FLASH_Unlock();
    /* 擦除目标扇区... */
    HAL_FLASH_Lock();
    return 0;
}

int BSP_Flash_Program(uint32_t addr, const uint8_t *data, uint32_t len) {
    uint32_t word_buf[16];
    HAL_FLASH_Unlock();
    for (uint32_t i = 0; i < len; i += 4) {
        HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, addr + i, *(const uint32_t *)(data + i));
    }
    HAL_FLASH_Lock();
    (void)word_buf;
    return 0;
}

const flash_ops_t g_stm32_flash_ops = {
    .erase = BSP_Flash_Erase,
    .write = BSP_Flash_Program,
};
`,
  "middleware/foc_core.c": `/**
 * @file foc_core.c
 * @brief 无感/有感永磁同步电机 FOC 电流环控制核心（纯静态零 Heap）
 */
#include "foc_core.h"

foc_motor_t g_foc_motor;
static const adc_ops_t *s_adc_ops = &g_stm32_adc_ops;

void FOC_Motor_Ctrl_Step(foc_motor_t *m) {
    float ia = 0.0f, ib = 0.0f;
    /* 通过接口表读取底层 ADC 三相采样电流 */
    s_adc_ops->read_phase_current(&ia, &ib);

    FOC_Clarke_Park(m, ia, ib);
    m->vd = FOC_PID_Update(&m->pid_d, m->id_ref - m->id);
    m->vq = FOC_PID_Update(&m->pid_q, m->iq_ref - m->iq);
    FOC_SVPWM_Generate(m, m->vd, m->vq);
}

void FOC_Clarke_Park(foc_motor_t *m, float ia, float ib) {
    float alpha = ia;
    float beta = (ia + 2.0f * ib) * 0.57735027f;
    m->id = alpha * m->cos_theta + beta * m->sin_theta;
    m->iq = -alpha * m->sin_theta + beta * m->cos_theta;
}

float FOC_PID_Update(pid_ctrl_t *pid, float err) {
    pid->integral += err * pid->ki;
    float out = err * pid->kp + pid->integral;
    return (out > pid->limit) ? pid->limit : out;
}

void FOC_SVPWM_Generate(foc_motor_t *m, float vd, float vq) {
    uint16_t ccr1 = (uint16_t)((vd + 1.0f) * 500.0f);
    uint16_t ccr2 = (uint16_t)((vq + 1.0f) * 500.0f);
    uint16_t ccr3 = 1000 - ccr1;
    HAL_TIM_PWM_SetCompare(ccr1, ccr2, ccr3);
}
`,
  "middleware/at_parser.c": `/**
 * @file at_parser.c
 * @brief AT 指令表分发器（包含一条隐蔽的宏指令回调递归风险示例）
 */
#include "at_parser.h"
#include <string.h>
#include <stdlib.h>

typedef int (*at_handler_t)(const char *args);
typedef struct {
    const char *cmd;
    at_handler_t handler;
} at_cmd_item_t;

static int AT_Handle_Reset(const char *args);
static int AT_Exec_Macro(const char *args);

static const at_cmd_item_t g_at_cmd_table[] = {
    { "AT+RST",   AT_Handle_Reset },
    { "AT+MACRO", AT_Exec_Macro   },
};

int AT_Cmd_Dispatch(const char *line) {
    char cmd_copy[192];
    strncpy(cmd_copy, line, sizeof(cmd_copy) - 1);
    for (int i = 0; i < 2; i++) {
        if (strncmp(cmd_copy, g_at_cmd_table[i].cmd, 6) == 0) {
            return g_at_cmd_table[i].handler(cmd_copy + 7);
        }
    }
    return -1;
}

static int AT_Exec_Macro(const char *args) {
    /* ⚠️ 使用动态堆分配，且通过嵌套调用形成隐蔽递归环路！ */
    char *expanded = (char *)pvPortMalloc(128);
    if (!expanded) return -1;
    strncpy(expanded, args, 127);
    int ret = AT_Cmd_Dispatch(expanded);
    vPortFree(expanded);
    return ret;
}

static int AT_Handle_Reset(const char *args) {
    (void)args;
    HAL_NVIC_SystemReset();
    return 0;
}
`,
};

export const DEMO_PROJECT: ProjectAnalysis = {
  projectName: "STM32F4_FreeRTOS_Bootloader_FOC",
  archBits: 32,
  targetMcuHint: "ARM Cortex-M4 (STM32F407 / FreeRTOS)",
  sourceKind: "DEMO",
  files: FILES,
  globals: [
    {
      name: "g_uart_ringbuf",
      typeStr: "ringbuf_t (uint8_t buf[2048] + head/tail)",
      bytes: 2052,
      file: "middleware/ringbuf.c",
      line: 7,
      isStatic: false,
      section: ".bss",
      description: "串口中断与 OTA 任务之间的无锁环形数据缓冲区",
    },
    {
      name: "g_ota_rx_sem",
      typeStr: "SemaphoreHandle_t",
      bytes: 4,
      file: "app/app_ota_task.c",
      line: 12,
      isStatic: false,
      section: ".bss",
      description: "ISR 收到字节后用于唤醒 vYmodemOtaTask 的二值信号量句柄",
    },
    {
      name: "s_flash_ops",
      typeStr: "const flash_ops_t *",
      bytes: 4,
      file: "middleware/ymodem_core.c",
      line: 9,
      isStatic: true,
      section: ".bss",
      description: "指向底层 Flash 擦写接口表的解耦指针",
    },
    {
      name: "s_rx_callback",
      typeStr: "uart_rx_cb_t",
      bytes: 4,
      file: "drivers/bsp_uart_dma.c",
      line: 8,
      isStatic: true,
      section: ".bss",
      description: "保存已注册的串口异步接收回调函数指针",
    },
    {
      name: "g_ota_status",
      typeStr: "static uint8_t",
      bytes: 1,
      file: "app/app_ota_task.c",
      line: 13,
      isStatic: true,
      section: ".bss",
      description: "OTA 升级当前状态标志",
    },
    {
      name: "g_foc_motor",
      typeStr: "foc_motor_t",
      bytes: 96,
      file: "middleware/foc_core.c",
      line: 7,
      isStatic: false,
      section: ".bss",
      description: "电机 FOC 控制状态结构体（三相电流、角度、双 PID 参数）",
    },
    {
      name: "g_at_cmd_table",
      typeStr: "const at_cmd_item_t[2]",
      bytes: 16,
      file: "middleware/at_parser.c",
      line: 16,
      isStatic: true,
      section: ".data",
      description: "AT 指令名称与回调处理器映射表",
    },
  ],
  nodes: {
    // ================= YMODEM OTA & UART ISR =================
    vYmodemOtaTask: {
      id: "vYmodemOtaTask",
      name: "vYmodemOtaTask",
      signature: "void vYmodemOtaTask(void *pvParameters)",
      file: "app/app_ota_task.c",
      lineStart: 24,
      lineEnd: 43,
      layer: "APP",
      hasStateMachine: false,
      stackBytes: 64,
      frameOverheadBytes: 24,
      localVars: [
        { name: "ctx", typeStr: "ymodem_ctx_t", bytes: 20 },
        { name: "ret", typeStr: "int", bytes: 4 },
        { name: "pvParameters", typeStr: "void *", bytes: 4 },
      ],
      readsGlobals: ["g_ota_rx_sem"],
      writesGlobals: ["g_ota_status"],
      brief: "FreeRTOS OTA 主任务：等待信号量触发状态机，超时发送握手字符 'C'",
      snippet: `for (;;) {
    if (xSemaphoreTake(g_ota_rx_sem, pdMS_TO_TICKS(1000)) == pdTRUE) {
        int ret = Ymodem_Receive_FSM(&ctx);
        if (ret == YMODEM_DONE) {
            g_ota_status = 2;
            HAL_NVIC_SystemReset();
        }
    } else {
        Ymodem_Send_Handshake();
    }
}`,
    },
    Ymodem_Receive_FSM: {
      id: "Ymodem_Receive_FSM",
      name: "Ymodem_Receive_FSM",
      signature: "int Ymodem_Receive_FSM(ymodem_ctx_t *ctx)",
      file: "middleware/ymodem_core.c",
      lineStart: 29,
      lineEnd: 51,
      layer: "CORE",
      hasStateMachine: true,
      stackBytes: 40,
      frameOverheadBytes: 24,
      localVars: [
        { name: "head", typeStr: "uint8_t", bytes: 4 },
        { name: "ctx", typeStr: "ymodem_ctx_t *", bytes: 4 },
      ],
      readsGlobals: ["g_uart_ringbuf"],
      writesGlobals: ["g_uart_ringbuf"],
      brief: "Ymodem 协议状态机核心：分发包头识别、数据解析与 EOT 结束流程",
      snippet: `if (RingBuf_Get(&g_uart_ringbuf, &head) != 0) return YMODEM_BUSY;
switch (ctx->state) {
    case YM_STATE_WAIT_HEAD:
        if (head == STX || head == SOH) {
            ctx->state = YM_STATE_RECV_DATA;
            return Ymodem_Parse_Packet(ctx, head);
        }
        break;
    case YM_STATE_RECV_DATA:
        return Ymodem_Parse_Packet(ctx, head);
}`,
    },
    Ymodem_Parse_Packet: {
      id: "Ymodem_Parse_Packet",
      name: "Ymodem_Parse_Packet",
      signature: "int Ymodem_Parse_Packet(ymodem_ctx_t *ctx, uint8_t head)",
      file: "middleware/ymodem_core.c",
      lineStart: 53,
      lineEnd: 78,
      layer: "CORE",
      stackBytes: 1328,
      frameOverheadBytes: 32,
      localVars: [
        { name: "pkt_buf", typeStr: "uint8_t[1024]", bytes: 1024, isArray: true, isLarge: true },
        { name: "dec_buf", typeStr: "uint8_t[256]", bytes: 256, isArray: true, isLarge: true },
        { name: "pkt_len", typeStr: "uint32_t", bytes: 4 },
        { name: "calc_crc", typeStr: "uint16_t", bytes: 4 },
      ],
      stackWarnings: [
        "局部大数组 pkt_buf[1024] (+1024B) 极易导致任务爆栈",
        "局部大数组 dec_buf[256] (+256B)，建议改为 static 或共用缓冲区",
      ],
      readsGlobals: ["g_uart_ringbuf", "s_flash_ops"],
      writesGlobals: ["g_uart_ringbuf"],
      brief: "解析 1K/128B 数据包、执行 CRC16 校验并通过接口表写入 Flash",
      snippet: `uint8_t pkt_buf[YMODEM_PACKET_1K_SIZE]; // ⚠️ 1024B 栈占用!
uint8_t dec_buf[256];
uint16_t calc_crc = Ymodem_Calc_CRC16(pkt_buf, pkt_len);
if (calc_crc != rx_crc) return YMODEM_ERR_CRC;

if (s_flash_ops && s_flash_ops->write) {
    s_flash_ops->write(ctx->write_addr, pkt_buf, pkt_len);
}`,
    },
    Ymodem_Calc_CRC16: {
      id: "Ymodem_Calc_CRC16",
      name: "Ymodem_Calc_CRC16",
      signature: "uint16_t Ymodem_Calc_CRC16(const uint8_t *buf, uint32_t len)",
      file: "middleware/ymodem_core.c",
      lineStart: 80,
      lineEnd: 90,
      layer: "CORE",
      stackBytes: 32,
      frameOverheadBytes: 16,
      localVars: [
        { name: "crc", typeStr: "uint16_t", bytes: 4 },
        { name: "i", typeStr: "uint32_t", bytes: 4 },
        { name: "b", typeStr: "int", bytes: 4 },
      ],
      readsGlobals: [],
      writesGlobals: [],
      brief: "纯算法 CRC16-CCITT 校验计算，无硬件依赖",
      snippet: `uint16_t crc = 0;
for (uint32_t i = 0; i < len; i++) {
    crc ^= ((uint16_t)buf[i] << 8);
    for (int b = 0; b < 8; b++)
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
}
return crc;`,
    },
    Ymodem_Send_Handshake: {
      id: "Ymodem_Send_Handshake",
      name: "Ymodem_Send_Handshake",
      signature: "void Ymodem_Send_Handshake(void)",
      file: "middleware/ymodem_core.c",
      lineStart: 24,
      lineEnd: 27,
      layer: "CORE",
      stackBytes: 24,
      frameOverheadBytes: 16,
      localVars: [{ name: "ch", typeStr: "uint8_t", bytes: 4 }],
      readsGlobals: [],
      writesGlobals: [],
      brief: "向下位机串口发送 'C' 启动 Ymodem 传输握手",
      snippet: `uint8_t ch = 'C';
HAL_UART_Transmit(&huart1, &ch, 1, 50);`,
    },
    RingBuf_Get: {
      id: "RingBuf_Get",
      name: "RingBuf_Get",
      signature: "int RingBuf_Get(ringbuf_t *rb, uint8_t *out)",
      file: "middleware/ringbuf.c",
      lineStart: 19,
      lineEnd: 26,
      layer: "CORE",
      stackBytes: 28,
      frameOverheadBytes: 16,
      localVars: [
        { name: "rb", typeStr: "ringbuf_t *", bytes: 4 },
        { name: "out", typeStr: "uint8_t *", bytes: 4 },
      ],
      readsGlobals: ["g_uart_ringbuf"],
      writesGlobals: ["g_uart_ringbuf"],
      brief: "从环形缓冲区取出 1 字节数据",
      snippet: `if (rb->head == rb->tail) return -1;
*out = rb->buf[rb->tail];
rb->tail = (rb->tail + 1) & (RINGBUF_SIZE - 1);
return 0;`,
    },
    RingBuf_Put: {
      id: "RingBuf_Put",
      name: "RingBuf_Put",
      signature: "int RingBuf_Put(ringbuf_t *rb, uint8_t data)",
      file: "middleware/ringbuf.c",
      lineStart: 9,
      lineEnd: 17,
      layer: "CORE",
      stackBytes: 28,
      frameOverheadBytes: 16,
      localVars: [
        { name: "next", typeStr: "uint16_t", bytes: 4 },
        { name: "data", typeStr: "uint8_t", bytes: 4 },
      ],
      readsGlobals: ["g_uart_ringbuf"],
      writesGlobals: ["g_uart_ringbuf"],
      brief: "中断安全地向环形缓冲区压入 1 字节数据",
      snippet: `uint16_t next = (rb->head + 1) & (RINGBUF_SIZE - 1);
if (next == rb->tail) return -1;
rb->buf[rb->head] = data;
rb->head = next;`,
    },
    On_Ymodem_Rx_Byte: {
      id: "On_Ymodem_Rx_Byte",
      name: "On_Ymodem_Rx_Byte",
      signature: "void On_Ymodem_Rx_Byte(uint8_t byte)",
      file: "middleware/ymodem_core.c",
      lineStart: 16,
      lineEnd: 22,
      layer: "CALLBACK",
      isCallback: true,
      stackBytes: 36,
      frameOverheadBytes: 20,
      localVars: [
        { name: "byte", typeStr: "uint8_t", bytes: 4 },
        { name: "woken", typeStr: "BaseType_t", bytes: 4 },
      ],
      readsGlobals: ["g_ota_rx_sem"],
      writesGlobals: ["g_uart_ringbuf"],
      brief: "异步接收回调：由串口 ISR 触发，存数据并释放信号量唤醒任务",
      snippet: `RingBuf_Put(&g_uart_ringbuf, byte);
BaseType_t woken = pdFALSE;
xSemaphoreGiveFromISR(g_ota_rx_sem, &woken);`,
    },
    USART1_IRQHandler: {
      id: "USART1_IRQHandler",
      name: "USART1_IRQHandler",
      signature: "void USART1_IRQHandler(void)",
      file: "drivers/bsp_uart_dma.c",
      lineStart: 21,
      lineEnd: 23,
      layer: "HAL",
      isIsr: true,
      stackBytes: 48,
      frameOverheadBytes: 32,
      localVars: [],
      readsGlobals: [],
      writesGlobals: [],
      brief: "硬件串口 1 中断服务入口（ARM Cortex-M 硬件压栈 32B）",
      snippet: `void USART1_IRQHandler(void) {
    HAL_UART_IRQHandler(&huart1);
}`,
    },
    HAL_UART_RxCpltCallback: {
      id: "HAL_UART_RxCpltCallback",
      name: "HAL_UART_RxCpltCallback",
      signature: "void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)",
      file: "drivers/bsp_uart_dma.c",
      lineStart: 26,
      lineEnd: 33,
      layer: "CALLBACK",
      isCallback: true,
      stackBytes: 32,
      frameOverheadBytes: 20,
      localVars: [{ name: "huart", typeStr: "UART_HandleTypeDef *", bytes: 4 }],
      readsGlobals: ["s_rx_callback"],
      writesGlobals: [],
      brief: "重写 STM32 HAL __weak 回调，分发至已注册的业务函数指针",
      snippet: `if (huart->Instance == USART1) {
    if (s_rx_callback != NULL) {
        s_rx_callback(s_dma_rx_byte); // 触发异步回调
    }
    HAL_UART_Receive_IT(&huart1, &s_dma_rx_byte, 1);
}`,
    },
    BSP_UART_Init: {
      id: "BSP_UART_Init",
      name: "BSP_UART_Init",
      signature: "void BSP_UART_Init(uint32_t baudrate)",
      file: "drivers/bsp_uart_dma.c",
      lineStart: 15,
      lineEnd: 19,
      layer: "HAL",
      stackBytes: 44,
      frameOverheadBytes: 24,
      localVars: [{ name: "baudrate", typeStr: "uint32_t", bytes: 4 }],
      readsGlobals: [],
      writesGlobals: [],
      brief: "STM32 HAL 串口初始化并开启接收中断（移植需替换为目标芯片驱动）",
      snippet: `huart1.Init.BaudRate = baudrate;
HAL_UART_Init(&huart1);
HAL_UART_Receive_IT(&huart1, &s_dma_rx_byte, 1);`,
    },
    BSP_Flash_Program: {
      id: "BSP_Flash_Program",
      name: "BSP_Flash_Program",
      signature: "int BSP_Flash_Program(uint32_t addr, const uint8_t *data, uint32_t len)",
      file: "drivers/bsp_flash_ops.c",
      lineStart: 14,
      lineEnd: 23,
      layer: "HAL",
      stackBytes: 112,
      frameOverheadBytes: 24,
      localVars: [
        { name: "word_buf", typeStr: "uint32_t[16]", bytes: 64, isArray: true },
        { name: "i", typeStr: "uint32_t", bytes: 4 },
      ],
      readsGlobals: [],
      writesGlobals: [],
      brief: "STM32 内部 Flash 编程写入实现（通过 flash_ops_t 解耦）",
      snippet: `HAL_FLASH_Unlock();
for (uint32_t i = 0; i < len; i += 4) {
    HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, addr + i, *(const uint32_t *)(data + i));
}
HAL_FLASH_Lock();`,
    },
    HAL_UART_Transmit: {
      id: "HAL_UART_Transmit",
      name: "HAL_UART_Transmit",
      signature: "HAL_StatusTypeDef HAL_UART_Transmit(UART_HandleTypeDef *, uint8_t *, uint16_t, uint32_t)",
      file: "Drivers/STM32F4xx_HAL/stm32f4xx_hal_uart.c",
      lineStart: 1,
      lineEnd: 1,
      layer: "HAL",
      isExternal: true,
      stackBytes: 48,
      localVars: [],
      readsGlobals: [],
      writesGlobals: [],
      brief: "STM32 HAL 库外部发送接口（跨芯片移植需替换为对应 UART TX）",
      snippet: `/* External STM32 HAL Library Symbol */\nHAL_StatusTypeDef HAL_UART_Transmit(...);`,
    },
    HAL_NVIC_SystemReset: {
      id: "HAL_NVIC_SystemReset",
      name: "HAL_NVIC_SystemReset",
      signature: "void HAL_NVIC_SystemReset(void)",
      file: "Drivers/CMSIS/core_cm4.h",
      lineStart: 1,
      lineEnd: 1,
      layer: "HAL",
      isExternal: true,
      stackBytes: 16,
      localVars: [],
      readsGlobals: [],
      writesGlobals: [],
      brief: "CMSIS 内核软复位指令（跨架构移植需替换）",
      snippet: `/* External CMSIS Core Intrinsic */\n__DSB(); SCB->AIRCR = ...;`,
    },
    xSemaphoreTake: {
      id: "xSemaphoreTake",
      name: "xSemaphoreTake",
      signature: "BaseType_t xSemaphoreTake(SemaphoreHandle_t xSemaphore, TickType_t xTicksToWait)",
      file: "Middlewares/FreeRTOS/queue.c",
      lineStart: 1,
      lineEnd: 1,
      layer: "HAL",
      isExternal: true,
      stackBytes: 56,
      localVars: [],
      readsGlobals: [],
      writesGlobals: [],
      brief: "FreeRTOS 信号量阻塞等待 API（移植到裸机或其他 OS 需适配）",
      snippet: `/* External FreeRTOS Kernel API */\nBaseType_t xSemaphoreTake(SemaphoreHandle_t, TickType_t);`,
    },
    xSemaphoreGiveFromISR: {
      id: "xSemaphoreGiveFromISR",
      name: "xSemaphoreGiveFromISR",
      signature: "BaseType_t xSemaphoreGiveFromISR(SemaphoreHandle_t, BaseType_t *)",
      file: "Middlewares/FreeRTOS/queue.c",
      lineStart: 1,
      lineEnd: 1,
      layer: "HAL",
      isExternal: true,
      stackBytes: 48,
      localVars: [],
      readsGlobals: [],
      writesGlobals: [],
      brief: "FreeRTOS 中断级信号量释放 API",
      snippet: `/* External FreeRTOS ISR API */\nBaseType_t xSemaphoreGiveFromISR(...);`,
    },
    HAL_UART_IRQHandler: {
      id: "HAL_UART_IRQHandler",
      name: "HAL_UART_IRQHandler",
      signature: "void HAL_UART_IRQHandler(UART_HandleTypeDef *huart)",
      file: "Drivers/STM32F4xx_HAL/stm32f4xx_hal_uart.c",
      lineStart: 1,
      lineEnd: 1,
      layer: "HAL",
      isExternal: true,
      stackBytes: 64,
      localVars: [],
      readsGlobals: [],
      writesGlobals: [],
      brief: "STM32 HAL 串口中断总控：清标志并调用 __weak HAL_UART_RxCpltCallback",
      snippet: `/* STM32 HAL Internal ISR Dispatcher */\nif (isrflags & USART_SR_RXNE) {\n    HAL_UART_RxCpltCallback(huart); // __weak\n}`,
    },

    // ================= FOC MOTOR CONTROL =================
    FOC_Motor_Ctrl_Step: {
      id: "FOC_Motor_Ctrl_Step",
      name: "FOC_Motor_Ctrl_Step",
      signature: "void FOC_Motor_Ctrl_Step(foc_motor_t *m)",
      file: "middleware/foc_core.c",
      lineStart: 10,
      lineEnd: 19,
      layer: "CORE",
      stackBytes: 40,
      localVars: [
        { name: "ia", typeStr: "float", bytes: 4 },
        { name: "ib", typeStr: "float", bytes: 4 },
      ],
      readsGlobals: ["g_foc_motor"],
      writesGlobals: ["g_foc_motor"],
      brief: "单周期 FOC 电流环控制对外 API（20kHz 高频调用，纯静态零 Heap）",
      snippet: `s_adc_ops->read_phase_current(&ia, &ib);
FOC_Clarke_Park(m, ia, ib);
m->vd = FOC_PID_Update(&m->pid_d, m->id_ref - m->id);
m->vq = FOC_PID_Update(&m->pid_q, m->iq_ref - m->iq);
FOC_SVPWM_Generate(m, m->vd, m->vq);`,
    },
    FOC_Clarke_Park: {
      id: "FOC_Clarke_Park",
      name: "FOC_Clarke_Park",
      signature: "void FOC_Clarke_Park(foc_motor_t *m, float ia, float ib)",
      file: "middleware/foc_core.c",
      lineStart: 21,
      lineEnd: 26,
      layer: "CORE",
      stackBytes: 32,
      localVars: [
        { name: "alpha", typeStr: "float", bytes: 4 },
        { name: "beta", typeStr: "float", bytes: 4 },
      ],
      readsGlobals: [],
      writesGlobals: ["g_foc_motor"],
      brief: "Clarke + Park 坐标变换（三相静止 ➔ 两相旋转 d-q 轴）",
      snippet: `float alpha = ia;
float beta = (ia + 2.0f * ib) * 0.57735027f;
m->id = alpha * m->cos_theta + beta * m->sin_theta;
m->iq = -alpha * m->sin_theta + beta * m->cos_theta;`,
    },
    FOC_PID_Update: {
      id: "FOC_PID_Update",
      name: "FOC_PID_Update",
      signature: "float FOC_PID_Update(pid_ctrl_t *pid, float err)",
      file: "middleware/foc_core.c",
      lineStart: 28,
      lineEnd: 32,
      layer: "CORE",
      stackBytes: 28,
      localVars: [{ name: "out", typeStr: "float", bytes: 4 }],
      readsGlobals: [],
      writesGlobals: [],
      brief: "抗饱和 PI 控制器单步更新",
      snippet: `pid->integral += err * pid->ki;
float out = err * pid->kp + pid->integral;
return (out > pid->limit) ? pid->limit : out;`,
    },
    FOC_SVPWM_Generate: {
      id: "FOC_SVPWM_Generate",
      name: "FOC_SVPWM_Generate",
      signature: "void FOC_SVPWM_Generate(foc_motor_t *m, float vd, float vq)",
      file: "middleware/foc_core.c",
      lineStart: 34,
      lineEnd: 39,
      layer: "CORE",
      stackBytes: 36,
      localVars: [
        { name: "ccr1", typeStr: "uint16_t", bytes: 4 },
        { name: "ccr2", typeStr: "uint16_t", bytes: 4 },
        { name: "ccr3", typeStr: "uint16_t", bytes: 4 },
      ],
      readsGlobals: [],
      writesGlobals: [],
      brief: "SVPWM 七段式占空比生成并下发定时器比较寄存器",
      snippet: `uint16_t ccr1 = (uint16_t)((vd + 1.0f) * 500.0f);
uint16_t ccr2 = (uint16_t)((vq + 1.0f) * 500.0f);
HAL_TIM_PWM_SetCompare(ccr1, ccr2, 1000 - ccr1);`,
    },
    BSP_ADC_ReadCurrent: {
      id: "BSP_ADC_ReadCurrent",
      name: "BSP_ADC_ReadCurrent",
      signature: "void BSP_ADC_ReadCurrent(float *ia, float *ib)",
      file: "drivers/bsp_adc_ops.c",
      lineStart: 1,
      lineEnd: 1,
      layer: "HAL",
      isExternal: true,
      stackBytes: 32,
      localVars: [],
      readsGlobals: [],
      writesGlobals: [],
      brief: "底层 ADC 注入通道读取接口（通过 adc_ops_t 解耦）",
      snippet: `/* Hardware ADC Current Sampling Driver */`,
    },
    HAL_TIM_PWM_SetCompare: {
      id: "HAL_TIM_PWM_SetCompare",
      name: "HAL_TIM_PWM_SetCompare",
      signature: "void HAL_TIM_PWM_SetCompare(uint16_t c1, uint16_t c2, uint16_t c3)",
      file: "Drivers/STM32F4xx_HAL/stm32f4xx_hal_tim.c",
      lineStart: 1,
      lineEnd: 1,
      layer: "HAL",
      isExternal: true,
      stackBytes: 24,
      localVars: [],
      readsGlobals: [],
      writesGlobals: [],
      brief: "高级定时器 TIM1 三相互补 PWM 占空比更新接口",
      snippet: `TIM1->CCR1 = c1; TIM1->CCR2 = c2; TIM1->CCR3 = c3;`,
    },

    // ================= AT COMMAND TABLE (WITH RECURSION & HEAP) =================
    AT_Cmd_Dispatch: {
      id: "AT_Cmd_Dispatch",
      name: "AT_Cmd_Dispatch",
      signature: "int AT_Cmd_Dispatch(const char *line)",
      file: "middleware/at_parser.c",
      lineStart: 21,
      lineEnd: 30,
      layer: "CORE",
      hasStateMachine: true,
      stackBytes: 224,
      localVars: [
        { name: "cmd_copy", typeStr: "char[192]", bytes: 192, isArray: true },
        { name: "i", typeStr: "int", bytes: 4 },
      ],
      readsGlobals: ["g_at_cmd_table"],
      writesGlobals: [],
      brief: "查表匹配 AT 指令并通过函数指针派发处理",
      snippet: `char cmd_copy[192];
for (int i = 0; i < 2; i++) {
    if (strncmp(cmd_copy, g_at_cmd_table[i].cmd, 6) == 0)
        return g_at_cmd_table[i].handler(cmd_copy + 7);
}`,
    },
    AT_Exec_Macro: {
      id: "AT_Exec_Macro",
      name: "AT_Exec_Macro",
      signature: "static int AT_Exec_Macro(const char *args)",
      file: "middleware/at_parser.c",
      lineStart: 32,
      lineEnd: 40,
      layer: "CALLBACK",
      isCallback: true,
      callsHeap: true,
      heapApis: ["pvPortMalloc", "vPortFree"],
      stackBytes: 44,
      localVars: [
        { name: "expanded", typeStr: "char *", bytes: 4 },
        { name: "ret", typeStr: "int", bytes: 4 },
      ],
      stackWarnings: ["存在跨回调间接递归环路 (AT_Exec_Macro ➔ AT_Cmd_Dispatch)，栈深不可界定！"],
      readsGlobals: [],
      writesGlobals: [],
      brief: "执行 AT 宏展开：含动态堆分配与嵌套派发递归风险",
      snippet: `char *expanded = (char *)pvPortMalloc(128);
strncpy(expanded, args, 127);
int ret = AT_Cmd_Dispatch(expanded); // 🔄 间接递归!
vPortFree(expanded);`,
    },
    AT_Handle_Reset: {
      id: "AT_Handle_Reset",
      name: "AT_Handle_Reset",
      signature: "static int AT_Handle_Reset(const char *args)",
      file: "middleware/at_parser.c",
      lineStart: 42,
      lineEnd: 46,
      layer: "CALLBACK",
      isCallback: true,
      stackBytes: 20,
      localVars: [],
      readsGlobals: [],
      writesGlobals: [],
      brief: "AT+RST 命令表回调：触发芯片复位",
      snippet: `HAL_NVIC_SystemReset();
return 0;`,
    },
  },
  edges: [
    // Ymodem OTA edges
    { id: "e_ota_1", source: "vYmodemOtaTask", target: "BSP_UART_Init", kind: "DIRECT", callSiteLine: 28 },
    { id: "e_ota_2", source: "vYmodemOtaTask", target: "xSemaphoreTake", kind: "DIRECT", callSiteLine: 33 },
    { id: "e_ota_3", source: "vYmodemOtaTask", target: "Ymodem_Receive_FSM", kind: "DIRECT", callSiteLine: 34 },
    { id: "e_ota_4", source: "vYmodemOtaTask", target: "Ymodem_Send_Handshake", kind: "DIRECT", callSiteLine: 40 },
    { id: "e_ota_5", source: "vYmodemOtaTask", target: "HAL_NVIC_SystemReset", kind: "DIRECT", callSiteLine: 37 },
    { id: "e_ota_6", source: "Ymodem_Send_Handshake", target: "HAL_UART_Transmit", kind: "DIRECT", callSiteLine: 26 },
    { id: "e_ota_7", source: "Ymodem_Receive_FSM", target: "RingBuf_Get", kind: "DIRECT", callSiteLine: 31 },
    { id: "e_ota_8", source: "Ymodem_Receive_FSM", target: "Ymodem_Parse_Packet", kind: "DIRECT", callSiteLine: 39 },
    { id: "e_ota_9", source: "Ymodem_Parse_Packet", target: "RingBuf_Get", kind: "DIRECT", callSiteLine: 61 },
    { id: "e_ota_10", source: "Ymodem_Parse_Packet", target: "Ymodem_Calc_CRC16", kind: "DIRECT", callSiteLine: 64 },
    {
      id: "e_ota_11",
      source: "Ymodem_Parse_Packet",
      target: "BSP_Flash_Program",
      kind: "OPS_TABLE",
      label: "s_flash_ops->write()",
      registeredAt: "App_OTA_Init:20 (Ymodem_BindFlashOps)",
      callSiteLine: 72,
    },
    // Async ISR -> Callback edges (shared in both OTA and ISR views)
    { id: "e_isr_1", source: "USART1_IRQHandler", target: "HAL_UART_IRQHandler", kind: "DIRECT", callSiteLine: 22 },
    {
      id: "e_isr_2",
      source: "HAL_UART_IRQHandler",
      target: "HAL_UART_RxCpltCallback",
      kind: "WEAK_OVERRIDE",
      label: "__weak 强重写",
    },
    {
      id: "e_isr_3",
      source: "HAL_UART_RxCpltCallback",
      target: "On_Ymodem_Rx_Byte",
      kind: "ASYNC_CALLBACK",
      label: "s_rx_callback()",
      registeredAt: "App_OTA_Init:18 (BSP_UART_RegisterRxCallback)",
      callSiteLine: 29,
    },
    { id: "e_isr_4", source: "On_Ymodem_Rx_Byte", target: "RingBuf_Put", kind: "DIRECT", callSiteLine: 18 },
    { id: "e_isr_5", source: "On_Ymodem_Rx_Byte", target: "xSemaphoreGiveFromISR", kind: "DIRECT", callSiteLine: 20 },

    // FOC edges
    {
      id: "e_foc_1",
      source: "FOC_Motor_Ctrl_Step",
      target: "BSP_ADC_ReadCurrent",
      kind: "OPS_TABLE",
      label: "s_adc_ops->read_phase_current()",
      callSiteLine: 13,
    },
    { id: "e_foc_2", source: "FOC_Motor_Ctrl_Step", target: "FOC_Clarke_Park", kind: "DIRECT", callSiteLine: 15 },
    { id: "e_foc_3", source: "FOC_Motor_Ctrl_Step", target: "FOC_PID_Update", kind: "DIRECT", callSiteLine: 16 },
    { id: "e_foc_4", source: "FOC_Motor_Ctrl_Step", target: "FOC_SVPWM_Generate", kind: "DIRECT", callSiteLine: 18 },
    { id: "e_foc_5", source: "FOC_SVPWM_Generate", target: "HAL_TIM_PWM_SetCompare", kind: "DIRECT", callSiteLine: 38 },

    // AT Cmd edges
    {
      id: "e_at_1",
      source: "AT_Cmd_Dispatch",
      target: "AT_Exec_Macro",
      kind: "OPS_TABLE",
      label: "g_at_cmd_table[1].handler()",
      callSiteLine: 26,
    },
    {
      id: "e_at_2",
      source: "AT_Cmd_Dispatch",
      target: "AT_Handle_Reset",
      kind: "OPS_TABLE",
      label: "g_at_cmd_table[0].handler()",
      callSiteLine: 26,
    },
    {
      id: "e_at_3",
      source: "AT_Exec_Macro",
      target: "AT_Cmd_Dispatch",
      kind: "ASYNC_CALLBACK",
      label: "嵌套宏展开递归调用",
      callSiteLine: 37,
    },
    { id: "e_at_4", source: "AT_Handle_Reset", target: "HAL_NVIC_SystemReset", kind: "DIRECT", callSiteLine: 44 },
  ],
  entries: [
    {
      id: "entry_ymodem_ota",
      name: "vYmodemOtaTask",
      displayName: "Ymodem 串口 OTA 升级任务",
      category: "RTOS_TASK",
      entryNodeId: "vYmodemOtaTask",
      rtosAllocatedStackBytes: 2048,
      summary:
        "基于 FreeRTOS 信号量驱动的 Ymodem-1K 固件升级功能：包含串口中断异步回调链、Flash 接口表解耦、以及一处高危局部大数组爆栈隐患。",
      nodeIds: [
        "vYmodemOtaTask",
        "Ymodem_Receive_FSM",
        "Ymodem_Parse_Packet",
        "Ymodem_Calc_CRC16",
        "Ymodem_Send_Handshake",
        "RingBuf_Get",
        "RingBuf_Put",
        "On_Ymodem_Rx_Byte",
        "USART1_IRQHandler",
        "HAL_UART_IRQHandler",
        "HAL_UART_RxCpltCallback",
        "BSP_UART_Init",
        "BSP_Flash_Program",
        "HAL_UART_Transmit",
        "HAL_NVIC_SystemReset",
        "xSemaphoreTake",
        "xSemaphoreGiveFromISR",
      ],
      edgeIds: [
        "e_ota_1",
        "e_ota_2",
        "e_ota_3",
        "e_ota_4",
        "e_ota_5",
        "e_ota_6",
        "e_ota_7",
        "e_ota_8",
        "e_ota_9",
        "e_ota_10",
        "e_ota_11",
        "e_isr_1",
        "e_isr_2",
        "e_isr_3",
        "e_isr_4",
        "e_isr_5",
      ],
      configMacros: [
        { name: "YMODEM_PACKET_1K_SIZE", defaultVal: "1024", file: "middleware/ymodem_core.h", purpose: "单包最大载荷字节数（直接决定栈缓冲大小）" },
        { name: "YMODEM_USE_CRC16", defaultVal: "1", file: "middleware/ymodem_core.h", purpose: "启用 CRC16 校验模式" },
        { name: "RINGBUF_SIZE", defaultVal: "2048", file: "middleware/ringbuf.c", purpose: "串口异步接收环形缓冲大小（需为 2 的幂）" },
      ],
      staticFlowOutline: [
        {
          id: "step_1",
          stage: "1. 任务启动与硬件初始化",
          title: "vYmodemOtaTask ➔ BSP_UART_Init",
          nodeId: "vYmodemOtaTask",
          detail: "初始化 115200 波特率串口并开启接收中断；初始化期已通过 App_OTA_Init 绑定 Flash 接口表与串口异步回调。",
          tag: "INIT",
        },
        {
          id: "step_2",
          stage: "2. 底层中断异步上抛闭环",
          title: "USART1_IRQHandler ➔ __weak ➔ On_Ymodem_Rx_Byte",
          nodeId: "On_Ymodem_Rx_Byte",
          detail: "硬件触发 USART1 中断，经 HAL_UART_RxCpltCallback(强重写) 通过 s_rx_callback 异步回调至 On_Ymodem_Rx_Byte，写入 g_uart_ringbuf 并释放 g_ota_rx_sem。",
          tag: "CALLBACK",
        },
        {
          id: "step_3",
          stage: "3. 协议状态机分发",
          title: "Ymodem_Receive_FSM (switch 3 状态)",
          nodeId: "Ymodem_Receive_FSM",
          detail: "被信号量唤醒后读取环形缓冲包头：WAIT_HEAD 识别 STX/SOH 进入数据接收；RECV_DATA 调用包解析；EOT 完成后复位芯片。",
          tag: "FSM",
        },
        {
          id: "step_4",
          stage: "4. 数据校验与解耦写入（⚠️ 爆栈风险点）",
          title: "Ymodem_Parse_Packet ➔ s_flash_ops->write()",
          nodeId: "Ymodem_Parse_Packet",
          detail: "函数内直接声明局部数组 pkt_buf[1024] + dec_buf[256] (栈帧达 ~1328B)！校验 CRC16 通过后，经 flash_ops_t 接口表调用 BSP_Flash_Program 落盘。",
          tag: "WARN",
        },
      ],
    },
    {
      id: "entry_usart1_isr",
      name: "USART1_IRQHandler",
      displayName: "USART1 串口接收中断与回调链",
      category: "ISR",
      entryNodeId: "USART1_IRQHandler",
      summary:
        "从 Cortex-M 硬件中断向量出发，穿过 STM32 HAL __weak 重写与函数指针回调，最终零阻塞投递到环形缓冲区的完整异步路径。",
      nodeIds: [
        "USART1_IRQHandler",
        "HAL_UART_IRQHandler",
        "HAL_UART_RxCpltCallback",
        "On_Ymodem_Rx_Byte",
        "RingBuf_Put",
        "xSemaphoreGiveFromISR",
      ],
      edgeIds: ["e_isr_1", "e_isr_2", "e_isr_3", "e_isr_4", "e_isr_5"],
      configMacros: [
        { name: "RINGBUF_SIZE", defaultVal: "2048", file: "middleware/ringbuf.c", purpose: "中断缓冲区大小" },
      ],
      staticFlowOutline: [
        {
          id: "isr_1",
          stage: "1. 硬件中断响应",
          title: "USART1_IRQHandler ➔ HAL_UART_IRQHandler",
          nodeId: "USART1_IRQHandler",
          detail: "Cortex-M 自动硬件压栈 32B，进入 STM32 HAL 中断总控清除 RXNE 标志位。",
          tag: "HAL",
        },
        {
          id: "isr_2",
          stage: "2. 弱函数重写 + 函数指针二次派发",
          title: "HAL_UART_RxCpltCallback ➔ s_rx_callback()",
          nodeId: "HAL_UART_RxCpltCallback",
          detail: "强定义覆盖 HAL 的 __weak 钩子，调用注册在 s_rx_callback 的业务回调 On_Ymodem_Rx_Byte，并重新开启下一字节中断接收。",
          tag: "CALLBACK",
        },
        {
          id: "isr_3",
          stage: "3. 零阻塞投递与任务唤醒",
          title: "RingBuf_Put + xSemaphoreGiveFromISR",
          nodeId: "On_Ymodem_Rx_Byte",
          detail: "将字节写入全局环形缓冲 g_uart_ringbuf 并从中断安全唤醒阻塞中的 OTA 任务。",
          tag: "CALLBACK",
        },
      ],
    },
    {
      id: "entry_foc_step",
      name: "FOC_Motor_Ctrl_Step",
      displayName: "FOC 电机矢量电流环核心 API",
      category: "PUBLIC_API",
      entryNodeId: "FOC_Motor_Ctrl_Step",
      summary:
        "高实时性纯静态（0 Heap / 低栈深）电机控制核心算法模块，通过 adc_ops_t 与定时器 PWM 接口实现与 MCU 硬件解耦，极易跨芯片移植。",
      nodeIds: [
        "FOC_Motor_Ctrl_Step",
        "BSP_ADC_ReadCurrent",
        "FOC_Clarke_Park",
        "FOC_PID_Update",
        "FOC_SVPWM_Generate",
        "HAL_TIM_PWM_SetCompare",
      ],
      edgeIds: ["e_foc_1", "e_foc_2", "e_foc_3", "e_foc_4", "e_foc_5"],
      configMacros: [],
      staticFlowOutline: [
        {
          id: "foc_1",
          stage: "1. 底层采样解耦读取",
          title: "s_adc_ops->read_phase_current()",
          nodeId: "BSP_ADC_ReadCurrent",
          detail: "通过接口表解耦获取两相电流采样值 ia, ib（移植到新芯片仅需替换此回调）。",
          tag: "HAL",
        },
        {
          id: "foc_2",
          stage: "2. 坐标变换与双环 PI 计算",
          title: "FOC_Clarke_Park ➔ FOC_PID_Update",
          nodeId: "FOC_Clarke_Park",
          detail: "纯浮点算术完成静止坐标系到旋转 d-q 轴变换，并分别更新直轴/交轴 PI 控制器。",
          tag: "FSM",
        },
        {
          id: "foc_3",
          stage: "3. SVPWM 占空比下发",
          title: "FOC_SVPWM_Generate ➔ HAL_TIM_PWM_SetCompare",
          nodeId: "FOC_SVPWM_Generate",
          detail: "将期望电压矢量转为三相定时器比较值并更新高级定时器 PWM 通道。",
          tag: "HAL",
        },
      ],
    },
    {
      id: "entry_at_cmd",
      name: "AT_Cmd_Dispatch",
      displayName: "AT 指令表分发器（含递归与堆风险）",
      category: "CMD_TABLE",
      entryNodeId: "AT_Cmd_Dispatch",
      summary:
        "演示结构体命令表回调识别、动态堆分配（pvPortMalloc）检测以及跨回调间接递归环路（AT_Cmd_Dispatch ⇄ AT_Exec_Macro）告警。",
      nodeIds: ["AT_Cmd_Dispatch", "AT_Exec_Macro", "AT_Handle_Reset", "HAL_NVIC_SystemReset"],
      edgeIds: ["e_at_1", "e_at_2", "e_at_3", "e_at_4"],
      configMacros: [],
      staticFlowOutline: [
        {
          id: "at_1",
          stage: "1. 命令表查表与函数指针派发",
          title: "AT_Cmd_Dispatch ➔ g_at_cmd_table[i].handler",
          nodeId: "AT_Cmd_Dispatch",
          detail: "拷贝输入行到局部数组 cmd_copy[192]，遍历静态命令表并调用对应处理器指针。",
          tag: "FSM",
        },
        {
          id: "at_2",
          stage: "2. 隐蔽递归环路与动态堆告警",
          title: "AT_Exec_Macro ⇄ AT_Cmd_Dispatch",
          nodeId: "AT_Exec_Macro",
          detail: "处理器内部调用 pvPortMalloc(128) 并重新回调 AT_Cmd_Dispatch，形成不可界定栈深的递归环路，移植前必须改为迭代队列！",
          tag: "WARN",
        },
      ],
    },
  ],
};
