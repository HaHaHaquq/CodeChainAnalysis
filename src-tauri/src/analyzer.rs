use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVarInfo {
    pub name: String,
    pub type_str: String,
    pub bytes: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_array: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_vla: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_large: Option<bool>,
}

#[derive(Debug, Clone)]
struct InlinePhase {
    title: String,
    calls: Vec<String>,
    configs: Vec<String>,
}

#[derive(Debug, Clone)]
struct ParsedFunc {
    name: String,
    signature: String,
    file: String,
    line_start: usize,
    line_end: usize,
    is_weak: bool,
    is_user_src: bool,
    doc_brief: Option<String>,
    inline_phases: Vec<InlinePhase>,
    config_assignments: Vec<String>,
    body: String,
    snippet: String,
    has_switch: bool,
    switch_cases: Vec<String>,
    local_vars: Vec<LocalVarInfo>,
    stack_bytes: u32,
    stack_warnings: Vec<String>,
    calls_heap: bool,
    heap_apis: Vec<String>,
    direct_calls: Vec<(String, usize, String)>,
    field_assignments: Vec<(String, String, usize)>,
    field_calls: Vec<(String, usize)>,
}

fn is_c_keyword(w: &str) -> bool {
    matches!(
        w,
        "if" | "else"
            | "for"
            | "while"
            | "switch"
            | "case"
            | "return"
            | "sizeof"
            | "typeof"
            | "alignof"
            | "defined"
            | "do"
            | "goto"
            | "break"
            | "continue"
            | "struct"
            | "union"
            | "enum"
            | "typedef"
            | "static"
            | "inline"
            | "const"
            | "volatile"
            | "extern"
            | "void"
            | "int"
            | "char"
            | "short"
            | "long"
            | "float"
            | "double"
            | "bool"
            | "uint8_t"
            | "uint16_t"
            | "uint32_t"
            | "uint64_t"
            | "int8_t"
            | "int16_t"
            | "int32_t"
            | "int64_t"
            | "size_t"
            | "uintptr_t"
            | "assert_param"
            | "UNUSED"
            | "ARG_UNUSED"
    )
}

fn is_trivial_c_std_call(w: &str) -> bool {
    matches!(
        w,
        "memcpy"
            | "memset"
            | "memcmp"
            | "memmove"
            | "strlen"
            | "strcmp"
            | "strncmp"
            | "strcpy"
            | "strncpy"
            | "snprintf"
            | "sprintf"
            | "printf"
            | "strtol"
            | "strchr"
            | "MIN"
            | "MAX"
            | "LO_BYTE"
            | "HI_BYTE"
            | "USB_LOG_DBG"
            | "USB_LOG_INFO"
            | "USB_LOG_WRN"
            | "USB_LOG_ERR"
            | "USB_LOG_RAW"
            | "USB_ASSERT"
            | "USB_ASSERT_MSG"
    )
}

fn is_syscall_boilerplate_file_or_fn(rel_file: &str, fn_name: &str) -> bool {
    let low_f = rel_file.to_lowercase();
    if low_f.ends_with("syscalls.c") || low_f.ends_with("sysmem.c") {
        return true;
    }
    matches!(
        fn_name,
        "_exit"
            | "_sbrk"
            | "_write"
            | "_read"
            | "_close"
            | "_fstat"
            | "_isatty"
            | "_lseek"
            | "_kill"
            | "_getpid"
            | "__io_putchar"
            | "__io_getchar"
            | "initialise_monitor_handles"
    )
}

fn is_heap_api(w: &str) -> bool {
    matches!(
        w,
        "malloc"
            | "calloc"
            | "realloc"
            | "free"
            | "pvPortMalloc"
            | "vPortFree"
            | "rt_malloc"
            | "rt_free"
            | "usb_osal_malloc"
            | "usb_osal_free"
    )
}

fn type_size_bytes(t: &str) -> Option<u32> {
    match t {
        "uint8_t" | "int8_t" | "char" | "bool" | "UBaseType_t" => Some(1),
        "uint16_t" | "int16_t" | "short" => Some(2),
        "uint32_t" | "int32_t" | "int" | "long" | "float" | "uintptr_t" | "size_t"
        | "HAL_StatusTypeDef" | "BaseType_t" => Some(4),
        "uint64_t" | "int64_t" | "double" => Some(8),
        "usb_setup_packet" | "usb_endpoint_descriptor" | "cdc_line_coding" | "usbd_endpoint" => {
            Some(8)
        }
        "usb_device_descriptor" => Some(18),
        "usb_configuration_descriptor" | "usb_interface_descriptor" => Some(9),
        "hub_port_status" => Some(4),
        "usbd_interface" => Some(24),
        "usbh_urb" => Some(64),
        "CBW" => Some(31),
        "CSW" => Some(13),
        "video_payload_header" => Some(12),
        "RCC_OscInitTypeDef" => Some(76),
        "RCC_ClkInitTypeDef" => Some(32),
        "MPU_Region_InitTypeDef" => Some(36),
        "CRYP_HandleTypeDef" => Some(88),
        "UART_HandleTypeDef" => Some(128),
        "GPIO_InitTypeDef" => Some(20),
        _ => None,
    }
}

fn classify_layer(rel_file: &str, fn_name: &str, is_weak: bool) -> &'static str {
    let low_file = rel_file.to_lowercase();
    let low_name = fn_name.to_lowercase();

    // MSP callback functions (e.g. HAL_CRYP_MspInit, HAL_UART_MspInit) and *_Callback are CALLBACK layer!
    if low_name.ends_with("mspinit")
        || low_name.ends_with("mspdeinit")
        || low_name.contains("callback")
        || low_name.ends_with("_cb")
        || low_name.contains("_event_")
        || low_name.contains("_notify_")
        || low_name.ends_with("_request_handler")
        || low_name.ends_with("_bulk_out")
        || low_name.ends_with("_bulk_in")
    {
        return "CALLBACK";
    }

    if low_file.starts_with("port/")
        || low_file.starts_with("osal/")
        || low_file.starts_with("platform/")
        || low_file.starts_with("drivers/")
        || low_file.contains("hal_driver/")
        || low_file.contains("/bsp/")
        || low_name.starts_with("usb_dc_")
        || low_name.starts_with("usb_hc_")
        || low_name.starts_with("usb_osal_")
        || low_name.starts_with("hal_")
        || low_name.starts_with("__hal_")
        || low_name.starts_with("ll_")
        || low_name.starts_with("bsp_")
        || low_name.starts_with("scb_")
        || low_name.ends_with("_irqhandler")
        || low_name.starts_with("fsdev_")
        || low_name.starts_with("dwc2_")
        || matches!(
            low_name.as_str(),
            "usbd_ep_open"
                | "usbd_ep_close"
                | "usbd_ep_start_write"
                | "usbd_ep_start_read"
                | "usbd_ep_set_stall"
                | "usbd_ep_clear_stall"
                | "usbd_set_address"
        )
    {
        return "HAL";
    }

    if is_weak {
        return "CALLBACK";
    }

    if low_file.starts_with("demo/")
        || low_file.starts_with("app/")
        || low_file.starts_with("tests/")
        || low_name == "main"
        || low_name == "lsusb"
        || low_name == "error_handler"
    {
        return "APP";
    }

    "CORE"
}

/**
 * Extract preceding Doxygen @brief or clean comment lines above line `fn_start_idx`.
 */
fn extract_preceding_doc_brief(lines: &[&str], fn_start_idx: usize) -> Option<String> {
    let mut idx = fn_start_idx;
    let mut comment_lines: Vec<String> = Vec::new();
    let mut in_block = false;

    while idx > 0 && (fn_start_idx - idx) <= 35 {
        idx -= 1;
        let t = lines[idx].trim();
        if t.is_empty() {
            if !comment_lines.is_empty() && !in_block {
                break;
            }
            continue;
        }
        if t.ends_with("*/") {
            in_block = true;
        }
        if in_block {
            let cleaned = t
                .trim_start_matches("/**")
                .trim_start_matches("/*")
                .trim_end_matches("*/")
                .trim_start_matches('*')
                .trim();
            if !cleaned.is_empty() && !cleaned.chars().all(|c| c == '*' || c == '-' || c == '=') {
                comment_lines.push(cleaned.to_string());
            }
            if t.starts_with("/*") {
                break;
            }
        } else if t.starts_with("//") {
            let cleaned = t.trim_start_matches('/').trim();
            if !cleaned.is_empty() {
                comment_lines.push(cleaned.to_string());
            }
        } else {
            break;
        }
    }

    if comment_lines.is_empty() {
        return None;
    }
    comment_lines.reverse();

    // Look for @brief line(s)
    let mut brief_parts: Vec<String> = Vec::new();
    let mut collecting_brief = false;
    for l in &comment_lines {
        if let Some(pos) = l.find("@brief") {
            collecting_brief = true;
            let rest = l[(pos + 6)..].trim();
            if !rest.is_empty() {
                brief_parts.push(rest.to_string());
            }
        } else if collecting_brief {
            if l.starts_with('@') || l.starts_with("This software") {
                break;
            }
            brief_parts.push(l.clone());
            if brief_parts.len() >= 3 {
                break;
            }
        }
    }

    let raw = if !brief_parts.is_empty() {
        brief_parts.join(" ")
    } else {
        comment_lines
            .into_iter()
            .filter(|l| !l.starts_with('@') && !l.contains("Copyright"))
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    };

    let compact = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.is_empty() {
        None
    } else {
        Some(compact)
    }
}

/**
 * Synthesize a rich, meaningful function brief from Doxygen @brief + inline phase comments + struct configs + calls!
 */
fn synthesize_meaningful_brief(pf: &ParsedFunc, layer: &str) -> String {
    let mut parts: Vec<String> = Vec::new();

    if let Some(doc) = &pf.doc_brief {
        if !doc.eq_ignore_ascii_case("Main program") && !doc.eq_ignore_ascii_case("HAL MSP module.") {
            let truncated = if doc.chars().count() > 86 {
                let s: String = doc.chars().take(84).collect();
                format!("{}…", s)
            } else {
                doc.clone()
            };
            parts.push(truncated);
        }
    }

    // Add inline phase titles if present (e.g., "##-1- Configure the CRYP peripheral", "##-2- Encryption Phase")
    if !pf.inline_phases.is_empty() {
        let phase_titles: Vec<String> = pf
            .inline_phases
            .iter()
            .map(|p| p.title.clone())
            .take(4)
            .collect();
        parts.push(format!("流程阶段: {}", phase_titles.join(" ➔ ")));
    }

    // Add key hardware/struct parameter configs (e.g. "Algorithm=CRYP_AES_GCM, KeySize=CRYP_KEYSIZE_128B")
    if !pf.config_assignments.is_empty() && parts.len() < 2 {
        let cfg_str = pf
            .config_assignments
            .iter()
            .take(3)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        parts.push(format!("配置: {}", cfg_str));
    }

    // Add key calls summary if still short
    if parts.is_empty() {
        let key_calls: Vec<String> = pf
            .direct_calls
            .iter()
            .map(|(c, _, _)| c.clone())
            .filter(|c| !is_trivial_c_std_call(c) && c != "Error_Handler")
            .take(4)
            .collect();
        if !key_calls.is_empty() {
            parts.push(format!("调用 {}", key_calls.join(" / ")));
        }
    }

    if parts.is_empty() {
        if !pf.switch_cases.is_empty() {
            return format!(
                "状态机分支处理 ({}) — {}:{}",
                pf.switch_cases
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", "),
                pf.file,
                pf.line_start
            );
        }
        return format!("{} ({} 层实现，位于 {}:{})", pf.signature, layer, pf.file, pf.line_start);
    }

    parts.join(" | ")
}

fn parse_c_file_functions(
    rel_file: &str,
    content: &str,
    macros: &HashMap<String, u32>,
    is_user_src: bool,
) -> Vec<ParsedFunc> {
    static FN_RE: OnceLock<Regex> = OnceLock::new();
    static ARR_RE: OnceLock<Regex> = OnceLock::new();
    static VAR_RE: OnceLock<Regex> = OnceLock::new();
    static CASE_RE: OnceLock<Regex> = OnceLock::new();
    static ASSIGN_RE: OnceLock<Regex> = OnceLock::new();
    static FIELD_CALL_RE: OnceLock<Regex> = OnceLock::new();
    static CALL_RE: OnceLock<Regex> = OnceLock::new();
    static CFG_ASSIGN_RE: OnceLock<Regex> = OnceLock::new();
    static INLINE_CMT_RE: OnceLock<Regex> = OnceLock::new();

    let fn_re = FN_RE.get_or_init(|| Regex::new(r"([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*$").unwrap());
    let arr_re = ARR_RE.get_or_init(|| {
        Regex::new(
            r"^(?:static\s+)?(?:const\s+)?(?:volatile\s+)?(?:struct\s+)?([a-zA-Z_]\w*)\s+(\*?\s*[a-zA-Z_]\w*)\s*\[\s*([a-zA-Z0-9_+-]+)\s*\]",
        )
        .unwrap()
    });
    let var_re = VAR_RE.get_or_init(|| {
        Regex::new(
            r"^(?:const\s+)?(?:volatile\s+)?(struct\s+[a-zA-Z_]\w*|[a-zA-Z_]\w*)\s+(\*?\s*[a-zA-Z_]\w*)\s*(?:=|;)",
        )
        .unwrap()
    });
    let case_re = CASE_RE.get_or_init(|| Regex::new(r"\bcase\s+([A-Za-z0-9_]+)\s*:").unwrap());
    let assign_re = ASSIGN_RE.get_or_init(|| {
        Regex::new(r"(?:->|\.)([a-zA-Z_]\w*)\s*=\s*&?\s*([a-zA-Z_]\w*)\s*[,;]").unwrap()
    });
    let field_call_re =
        FIELD_CALL_RE.get_or_init(|| Regex::new(r"(?:->|\.)([a-zA-Z_]\w*)\s*\(").unwrap());
    let call_re =
        CALL_RE.get_or_init(|| Regex::new(r"\b([a-zA-Z_]\w*)\s*\(").unwrap());
    let cfg_assign_re = CFG_ASSIGN_RE.get_or_init(|| {
        Regex::new(r"([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*|\->[a-zA-Z_]\w*)+)\s*=\s*([A-Za-z0-9_]+)\s*;")
            .unwrap()
    });
    let inline_cmt_re =
        INLINE_CMT_RE.get_or_init(|| Regex::new(r"/\*+\s*(.*?)\s*\*+/").unwrap());

    let lines: Vec<&str> = content.lines().collect();
    let mut results = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let trimmed = line.trim();

        if trimmed.is_empty()
            || trimmed.starts_with("//")
            || trimmed.starts_with("/*")
            || trimmed.starts_with('*')
            || trimmed.starts_with('#')
            || trimmed.starts_with("typedef")
        {
            i += 1;
            continue;
        }

        let starts_ident = line
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic() || c == '_')
            .unwrap_or(false);

        if starts_ident && line.contains('(') && !line.contains(';') {
            let mut header_text = line.to_string();
            let mut brace_idx = i;
            while brace_idx < (i + 4).min(lines.len().saturating_sub(1))
                && !header_text.contains('{')
                && !header_text.contains(';')
            {
                brace_idx += 1;
                header_text.push(' ');
                header_text.push_str(lines[brace_idx].trim());
            }

            if !header_text.contains('{') || header_text.contains(';') {
                i += 1;
                continue;
            }

            let brace_pos = header_text.find('{').unwrap();
            let before_brace = header_text[..brace_pos].trim();
            let Some(caps) = fn_re.captures(before_brace) else {
                i += 1;
                continue;
            };
            let fn_name = caps[1].to_string();
            if is_c_keyword(&fn_name) {
                i += 1;
                continue;
            }

        let mut depth: i32 = 0;
            let mut end_idx = brace_idx;
            let mut started = false;
            for (k, l) in lines.iter().enumerate().skip(i) {
                let t = l.trim();
                if t.starts_with('*') || t.starts_with("//") || t.starts_with("/*") {
                    continue;
                }
                let code_part = l.split("//").next().unwrap_or("");
                for ch in code_part.chars() {
                    if ch == '{' {
                        depth += 1;
                        started = true;
                    } else if ch == '}' {
                        depth -= 1;
                        if started && depth == 0 {
                            end_idx = k;
                            break;
                        }
                    }
                }
                if started && depth == 0 {
                    break;
                }
            }

            if !started || end_idx <= i {
                i += 1;
                continue;
            }

            let doc_brief = extract_preceding_doc_brief(&lines, i);
            let body_lines = &lines[(brace_idx + 1)..end_idx];
            let body = body_lines.join("\n");

            // Build meaningful snippet (prefer lines with calls, assignments, or phase comments)
            let snippet_lines: Vec<&str> = body_lines
                .iter()
                .copied()
                .filter(|l| {
                    let t = l.trim();
                    !t.is_empty() && t != "{" && t != "}"
                })
                .take(14)
                .collect();
            let snippet = if snippet_lines.is_empty() {
                before_brace.to_string()
            } else {
                snippet_lines.join("\n")
            };

            let is_weak = before_brace.contains("__WEAK")
                || before_brace.contains("__weak")
                || before_brace.contains("weak");
            let is_isr = fn_name.ends_with("_IRQHandler") || fn_name.ends_with("_Handler");
            let has_switch = body.contains("switch (") || body.contains("switch(");

            let mut switch_cases = Vec::new();
            for cm in case_re.captures_iter(&body) {
                let c = cm[1].to_string();
                if !switch_cases.contains(&c) && switch_cases.len() < 6 {
                    switch_cases.push(c);
                }
            }

            // Stack analysis
            let mut local_vars = Vec::new();
            let mut stack_warnings = Vec::new();
            let mut seen_vars = HashSet::new();

            for raw_l in body_lines {
                let clean = raw_l.split("//").next().unwrap_or("").trim();
                if clean.is_empty() || clean.starts_with('*') || clean.starts_with('#') {
                    continue;
                }
                if clean.starts_with("if ")
                    || clean.starts_with("for ")
                    || clean.starts_with("while ")
                    || clean.starts_with("switch ")
                    || clean.starts_with("return")
                {
                    continue;
                }

                if !clean.starts_with("static ") {
                    if let Some(ac) = arr_re.captures(clean) {
                        let base_t = &ac[1];
                        let var_name = ac[2].replace('*', "").trim().to_string();
                        let dim_raw = ac[3].trim();
                        if !is_c_keyword(&var_name) && seen_vars.insert(var_name.clone()) {
                            let is_ptr = ac[2].contains('*');
                            let elem_sz = if is_ptr {
                                4
                            } else {
                                type_size_bytes(base_t).unwrap_or(4)
                            };
                            let (count, is_vla) = if let Ok(n) = dim_raw.parse::<u32>() {
                                (n, false)
                            } else if let Some(&mval) = macros.get(dim_raw) {
                                (mval, false)
                            } else {
                                (64, true)
                            };
                            let total_bytes = (elem_sz * count).max(4);
                            let is_large = total_bytes >= 128;
                            if is_large {
                                stack_warnings.push(format!(
                                    "局部数组 {}[{}] 占用 {} Bytes 栈空间",
                                    var_name, dim_raw, total_bytes
                                ));
                            }
                            local_vars.push(LocalVarInfo {
                                name: var_name,
                                type_str: format!("{}[{}]", base_t, dim_raw),
                                bytes: total_bytes,
                                is_array: Some(true),
                                is_vla: if is_vla { Some(true) } else { None },
                                is_large: if is_large { Some(true) } else { None },
                            });
                            continue;
                        }
                    }

                    if !clean.contains('(') {
                        if let Some(vc) = var_re.captures(clean) {
                            let raw_t = vc[1].split_whitespace().collect::<Vec<_>>().join(" ");
                            let raw_n = vc[2].trim();
                            let is_ptr = raw_n.starts_with('*');
                            let var_name = raw_n.replace('*', "").trim().to_string();
                            let clean_t = raw_t.trim_start_matches("struct ").trim();

                            if !is_c_keyword(&var_name)
                                && (!is_c_keyword(clean_t) || type_size_bytes(clean_t).is_some())
                                && seen_vars.insert(var_name.clone())
                            {
                                let bytes = if is_ptr {
                                    4
                                } else {
                                    type_size_bytes(clean_t).unwrap_or(4)
                                };
                                local_vars.push(LocalVarInfo {
                                    name: var_name,
                                    type_str: if is_ptr {
                                        format!("{} *", raw_t)
                                    } else {
                                        raw_t
                                    },
                                    bytes,
                                    is_array: None,
                                    is_vla: None,
                                    is_large: None,
                                });
                            }
                        }
                    }
                }
            }

            let frame_overhead = if is_isr { 36 } else { 20 };
            let vars_total: u32 = local_vars.iter().map(|v| ((v.bytes + 3) / 4) * 4).sum();
            let stack_bytes = frame_overhead + vars_total;

            let mut direct_calls = Vec::new();
            let mut field_assignments = Vec::new();
            let mut field_calls = Vec::new();
            let mut config_assignments = Vec::new();
            let mut inline_phases: Vec<InlinePhase> = Vec::new();
            let mut seen_callees = HashSet::new();
            let mut seen_fcalls = HashSet::new();
            let mut heap_apis = Vec::new();
            let mut in_multiline_comment = false;

            for (offset, b_line) in body_lines.iter().enumerate() {
                let line_num = brace_idx + 2 + offset;

                // Extract inline phase comments like /*##-1- Configure the CRYP peripheral ###*/ or /* Enable CRYP clock */
                if is_user_src {
                    if let Some(cm) = inline_cmt_re.captures(b_line) {
                        let raw_c = cm[1].trim_matches('#').trim_matches('-').trim();
                        if raw_c.len() >= 6
                            && !raw_c.eq_ignore_ascii_case("Infinite loop")
                            && !raw_c.contains("Error")
                            && !raw_c.starts_with("Set the")
                            && !raw_c.starts_with("Compare results")
                        {
                            if b_line.contains("##-")
                                || inline_phases.is_empty()
                                || raw_c.starts_with("Configure")
                                || raw_c.starts_with("Enable")
                                || raw_c.starts_with("Compute")
                            {
                                inline_phases.push(InlinePhase {
                                    title: raw_c.to_string(),
                                    calls: Vec::new(),
                                    configs: Vec::new(),
                                });
                            }
                        }
                    }
                }

                let trimmed_b = b_line.trim();
                if in_multiline_comment {
                    if trimmed_b.contains("*/") {
                        in_multiline_comment = false;
                    }
                    continue;
                }
                if trimmed_b.starts_with("/*") {
                    if !trimmed_b.contains("*/") {
                        in_multiline_comment = true;
                    }
                    continue;
                }

                let clean = b_line.split("//").next().unwrap_or("");
                let clean = clean.split("/*").next().unwrap_or(clean);

                // Extract struct config assignments like CrypHandle.Init.Algorithm = CRYP_AES_GCM;
                if is_user_src {
                    if let Some(cfgm) = cfg_assign_re.captures(clean) {
                        let lhs = cfgm[1].trim();
                        let rhs = cfgm[2].trim();
                        let short_lhs = lhs.split('.').last().unwrap_or(lhs);
                        let item = format!("{}={}", short_lhs, rhs);
                        if config_assignments.len() < 8 && !config_assignments.contains(&item) {
                            config_assignments.push(item.clone());
                        }
                        if let Some(last_phase) = inline_phases.last_mut() {
                            if last_phase.configs.len() < 5 {
                                last_phase.configs.push(item);
                            }
                        }
                    }
                }

                if let Some(am) = assign_re.captures(clean) {
                    let fld = am[1].to_string();
                    let tfn = am[2].to_string();
                    if !is_c_keyword(&tfn) {
                        field_assignments.push((fld, tfn, line_num));
                    }
                }

                for fm in field_call_re.captures_iter(clean) {
                    let fld = fm[1].to_string();
                    if !is_c_keyword(&fld) && seen_fcalls.insert(fld.clone()) {
                        field_calls.push((fld, line_num));
                    }
                }

                for cm in call_re.captures_iter(clean) {
                    let full_m = cm.get(0).unwrap();
                    let callee = cm[1].to_string();
                    if is_c_keyword(&callee) {
                        continue;
                    }
                    let after_paren = &clean[full_m.end()..];
                    let args_text = after_paren
                        .split(')')
                        .next()
                        .unwrap_or("")
                        .to_string();
                    if is_heap_api(&callee) && !heap_apis.contains(&callee) {
                        heap_apis.push(callee.clone());
                    }
                    if seen_callees.insert(callee.clone()) {
                        direct_calls.push((callee.clone(), line_num, args_text));
                    }
                    if let Some(last_phase) = inline_phases.last_mut() {
                        if !is_trivial_c_std_call(&callee)
                            && callee != "Error_Handler"
                            && !last_phase.calls.contains(&callee)
                        {
                            last_phase.calls.push(callee);
                        }
                    }
                }
            }

            results.push(ParsedFunc {
                name: fn_name,
                signature: before_brace.split_whitespace().collect::<Vec<_>>().join(" "),
                file: rel_file.to_string(),
                line_start: i + 1,
                line_end: end_idx + 1,
                is_weak,
                is_user_src,
                doc_brief,
                inline_phases,
                config_assignments,
                body,
                snippet,
                has_switch,
                switch_cases,
                local_vars,
                stack_bytes,
                stack_warnings,
                calls_heap: !heap_apis.is_empty(),
                heap_apis,
                direct_calls,
                field_assignments,
                field_calls,
            });

            i = end_idx + 1;
            continue;
        }

        i += 1;
    }

    results
}

/**
 * Parse global variables & buffers from user C files (e.g. CrypHandle, AES128Key[4], EncryptedText[4], TAG[4]).
 */
fn parse_global_variables(
    rel_file: &str,
    content: &str,
    macros: &HashMap<String, u32>,
) -> Vec<Value> {
    static GLOB_ARR_RE: OnceLock<Regex> = OnceLock::new();
    static GLOB_STRUCT_RE: OnceLock<Regex> = OnceLock::new();

    let arr_re = GLOB_ARR_RE.get_or_init(|| {
        Regex::new(
            r"^(?:static\s+)?(?:const\s+)?(?:volatile\s+)?([a-zA-Z_]\w*)\s+([a-zA-Z_]\w*)\s*\[\s*([A-Za-z0-9_]+)?\s*\]",
        )
        .unwrap()
    });
    let struct_re = GLOB_STRUCT_RE.get_or_init(|| {
        Regex::new(r"^(?:static\s+)?(struct\s+[a-zA-Z_]\w*|[A-Z][A-Za-z0-9_]*_HandleTypeDef|[a-zA-Z_]\w*_t)\s+([a-zA-Z_]\w*)\s*(?:=|;)")
            .unwrap()
    });

    let mut globals = Vec::new();
    let lines: Vec<&str> = content.lines().collect();
    let mut brace_depth: i32 = 0;
    let mut last_comment = String::new();

    for (idx, raw_line) in lines.iter().enumerate() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with("/*") && trimmed.ends_with("*/") {
            let c = trimmed
                .trim_start_matches("/*")
                .trim_end_matches("*/")
                .trim_matches('*')
                .trim();
            if !c.is_empty() && !c.contains("Private variables") {
                last_comment = c.to_string();
            }
        } else if trimmed.starts_with("//") {
            last_comment = trimmed.trim_start_matches('/').trim().to_string();
        }

        if brace_depth == 0 && !trimmed.starts_with('#') && !trimmed.starts_with("typedef") {
            if let Some(ac) = arr_re.captures(trimmed) {
                let base_t = &ac[1];
                let name = &ac[2];
                let dim_str = ac.get(3).map(|m| m.as_str()).unwrap_or("4");
                if !is_c_keyword(name) {
                    let elem_sz = type_size_bytes(base_t).unwrap_or(4);
                    let count = dim_str
                        .parse::<u32>()
                        .ok()
                        .or_else(|| macros.get(dim_str).copied())
                        .unwrap_or(4);
                    let bytes = (elem_sz * count).max(4);
                    let is_static = trimmed.starts_with("static ");
                    let section = if trimmed.contains('=') { ".data" } else { ".bss" };
                    globals.push(json!({
                        "name": name,
                        "typeStr": format!("{}[{}]", base_t, dim_str),
                        "bytes": bytes,
                        "file": rel_file,
                        "line": idx + 1,
                        "isStatic": is_static,
                        "section": section,
                        "description": if last_comment.is_empty() { format!("全局数组缓冲区 ({}:{})", rel_file, idx + 1) } else { last_comment.clone() }
                    }));
                    last_comment.clear();
                }
            } else if let Some(sc) = struct_re.captures(trimmed) {
                let type_s = &sc[1];
                let name = &sc[2];
                if !is_c_keyword(name) && !trimmed.contains('(') {
                    let bytes = type_size_bytes(type_s).unwrap_or(32);
                    let is_static = trimmed.starts_with("static ");
                    let section = if trimmed.contains('=') { ".data" } else { ".bss" };
                    globals.push(json!({
                        "name": name,
                        "typeStr": type_s,
                        "bytes": bytes,
                        "file": rel_file,
                        "line": idx + 1,
                        "isStatic": is_static,
                        "section": section,
                        "description": if last_comment.is_empty() { format!("外设句柄/全局状态结构体 ({}:{})", rel_file, idx + 1) } else { last_comment.clone() }
                    }));
                    last_comment.clear();
                }
            }
        }

        if trimmed.starts_with('*') || trimmed.starts_with("/*") || trimmed.starts_with("//") {
            continue;
        }
        let code_only = trimmed.split("/*").next().unwrap_or("").split("//").next().unwrap_or("");
        for ch in code_only.chars() {
            if ch == '{' {
                brace_depth += 1;
            } else if ch == '}' {
                brace_depth = (brace_depth - 1).max(0);
            }
        }
    }

    globals
}

/**
 * Discover external linked SDK files from Keil .uvprojx / IAR .ewp / Eclipse .project
 */
fn discover_ide_project_linked_files(root_path: &Path) -> Vec<(String, PathBuf)> {
    static UV_RE: OnceLock<Regex> = OnceLock::new();
    let uv_re =
        UV_RE.get_or_init(|| Regex::new(r"<FilePath>([^<]+\.(?:c|h|s|S))</FilePath>").unwrap());

    let mut linked = Vec::new();
    let mut seen = HashSet::new();

    for entry in WalkDir::new(root_path).max_depth(3).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
        if matches!(ext, "uvprojx" | "uvproj" | "ewp") {
            let Some(proj_dir) = p.parent() else { continue };
            if let Ok(xml) = fs::read_to_string(p) {
                for caps in uv_re.captures_iter(&xml) {
                    let raw_rel = caps[1].trim().replace("$PROJ_DIR$\\", "").replace("$PROJ_DIR$/", "");
                    let candidate = proj_dir.join(&raw_rel);
                    if let Ok(canon) = fs::canonicalize(&candidate) {
                        if canon.exists() && seen.insert(canon.clone()) {
                            // Build a clean display path: if inside root_path, relative to root_path; otherwise keep last 3 segments (e.g. Drivers/STM32H7xx_HAL_Driver/Src/stm32h7xx_hal_cryp.c)
                            let disp = if let Ok(sub) = canon.strip_prefix(root_path) {
                                sub.to_string_lossy().replace('\\', "/")
                            } else {
                                let comps: Vec<String> = canon
                                    .components()
                                    .rev()
                                    .take(4)
                                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                                    .collect::<Vec<_>>()
                                    .into_iter()
                                    .rev()
                                    .collect();
                                comps.join("/")
                            };
                            linked.push((disp, canon));
                        }
                    }
                }
            }
        }
    }

    linked
}

/**
 * Extract project description from readme.txt / README.md if present.
 */
fn extract_project_readme_summary(root_path: &Path) -> Option<String> {
    for name in ["readme.txt", "README.txt", "README.md", "readme.md"] {
        let p = root_path.join(name);
        if p.exists() {
            if let Ok(txt) = fs::read_to_string(&p) {
                // Check for @brief or @par Example Description
                let mut lines_out = Vec::new();
                let mut in_desc = false;
                for l in txt.lines() {
                    let t = l.trim().trim_start_matches('*').trim();
                    if t.starts_with("@brief") {
                        lines_out.push(t.trim_start_matches("@brief").trim().to_string());
                    } else if t.starts_with("@par Example Description") {
                        in_desc = true;
                    } else if in_desc {
                        if t.starts_with('@') || lines_out.len() >= 5 {
                            break;
                        }
                        if !t.is_empty() {
                            lines_out.push(t.to_string());
                        }
                    }
                }
                if !lines_out.is_empty() {
                    return Some(lines_out.join(" "));
                }
            }
        }
    }
    None
}

pub fn analyze_local_c_project_with_progress<F>(
    root_dir: &str,
    mut on_progress: F,
) -> Result<Value, String>
where
    F: FnMut(u32, &str, &str),
{
    on_progress(5, "正在扫描工程目录与 IDE 工程文件...", root_dir);
    let root_path = Path::new(root_dir);
    if !root_path.exists() {
        return Err(format!("目录不存在: {}", root_dir));
    }

    let is_cherry_usb = root_path.join("core").join("usbd_core.c").exists()
        && root_path.join("core").join("usbh_core.c").exists();

    // (display_rel_path, disk_full_path, is_local_user_file)
    let mut target_files: Vec<(String, PathBuf, bool)> = Vec::new();
    let mut seen_disp = HashSet::new();

    if is_cherry_usb {
        let cherry_files = [
            "cherryusb_config_template.h",
            "common/usb_dc.h",
            "common/usb_hc.h",
            "common/usb_osal.h",
            "common/usb_def.h",
            "core/usbd_core.h",
            "core/usbd_core.c",
            "core/usbh_core.h",
            "core/usbh_core.c",
            "class/cdc/usbd_cdc_acm.h",
            "class/cdc/usbd_cdc_acm.c",
            "class/msc/usbd_msc.h",
            "class/msc/usbd_msc.c",
            "class/msc/usbh_msc.h",
            "class/msc/usbh_msc.c",
            "class/hid/usbd_hid.h",
            "class/hid/usbd_hid.c",
            "class/dfu/usbd_dfu.h",
            "class/dfu/usbd_dfu.c",
            "class/audio/usbd_audio.h",
            "class/audio/usbd_audio.c",
            "class/video/usbd_video.h",
            "class/video/usbd_video.c",
            "class/hub/usbh_hub.h",
            "class/hub/usbh_hub.c",
            "class/serial/usbh_serial.h",
            "class/serial/usbh_serial.c",
            "demo/cdc_acm_template.c",
            "demo/msc_ram_template.c",
            "demo/hid_keyboard_template.c",
            "demo/usb_host.c",
            "port/fsdev/usb_dc_fsdev.c",
            "port/dwc2/usb_dc_dwc2.c",
            "osal/usb_osal_freertos.c",
        ];
        for f in cherry_files {
            let full = root_path.join(f);
            if full.exists() {
                seen_disp.insert(f.to_string());
                target_files.push((f.to_string(), full, true));
            }
        }
    } else {
        // 1. Scan all local .c/.h files inside root_path
        for entry in WalkDir::new(root_path)
            .max_depth(5)
            .into_iter()
            .filter_entry(|e| {
                let n = e.file_name().to_string_lossy();
                !n.starts_with('.')
                    && n != "node_modules"
                    && n != "third_party"
                    && n != "build"
                    && n != "target"
                    && n != "Exe"
                    && n != "Obj"
            })
            .flatten()
        {
            if target_files.len() >= 70 {
                break;
            }
            if entry.file_type().is_file() {
                let p = entry.path();
                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    if matches!(ext, "c" | "cpp" | "h" | "hpp") {
                        if let Ok(rel) = p.strip_prefix(root_path) {
                            let disp = rel.to_string_lossy().replace('\\', "/");
                            if !is_syscall_boilerplate_file_or_fn(&disp, "")
                                && seen_disp.insert(disp.clone())
                            {
                                target_files.push((disp, p.to_path_buf(), true));
                            }
                        }
                    }
                }
            }
        }

        // 2. Also discover linked SDK / HAL driver files from Keil .uvprojx / IAR .ewp!
        on_progress(10, "正在解析 Keil/IAR 工程外部驱动引用 (.uvprojx/.ewp)...", "");
        for (disp, full_path) in discover_ide_project_linked_files(root_path) {
            if target_files.len() >= 110 {
                break;
            }
            if (disp.ends_with(".c") || disp.ends_with(".h"))
                && !is_syscall_boilerplate_file_or_fn(&disp, "")
                && seen_disp.insert(disp.clone())
            {
                let is_local = !disp.starts_with("Drivers/");
                target_files.push((disp, full_path, is_local));
            }
        }
    }

    // Check startup.s / linker script for MSP Stack_Size
    let mut detected_msp_stack_bytes: u32 = 1024;
    let mut msp_stack_source = "默认裸机主栈基准 (MSP Stack_Size = 0x0400 / 1024B)".to_string();
    let stack_equ_re =
        Regex::new(r"(?i)(?:Stack_Size\s+EQU|_Min_Stack_Size\s*=|size_of_stack\s*=)\s*(0x[0-9a-fA-F]+|\d+)").unwrap();
    for entry in WalkDir::new(root_path).max_depth(3).into_iter().flatten() {
        if entry.file_type().is_file() {
            let ext = entry
                .path()
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if matches!(ext, "s" | "S" | "ld" | "sct" | "icf") {
                if let Ok(txt) = fs::read_to_string(entry.path()) {
                    if let Some(caps) = stack_equ_re.captures(&txt) {
                        let raw_val = &caps[1];
                        let parsed = if let Some(hex) = raw_val.strip_prefix("0x").or_else(|| raw_val.strip_prefix("0X")) {
                            u32::from_str_radix(hex, 16).ok()
                        } else {
                            raw_val.parse::<u32>().ok()
                        };
                        if let Some(v) = parsed {
                            if (128..=65536).contains(&v) {
                                detected_msp_stack_bytes = v;
                                let fname = entry.file_name().to_string_lossy();
                                msp_stack_source =
                                    format!("{} (MSP Stack_Size = {} / {}B)", fname, raw_val, v);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    let mut files_content: HashMap<String, String> = HashMap::new();
    let mut macros: HashMap<String, u32> = HashMap::new();
    macros.insert("CONFIG_USBDEV_REQUEST_BUFFER_LEN".into(), 512);
    macros.insert("CONFIG_USBHOST_REQUEST_BUFFER_LEN".into(), 512);
    macros.insert("CONFIG_USBHOST_PSC_STACKSIZE".into(), 2048);
    macros.insert("CONFIG_USBDEV_EP0_STACKSIZE".into(), 2048);
    macros.insert("CDC_MAX_MPS".into(), 64);

    let def_re = Regex::new(r"#define\s+([A-Z0-9_]+)\s+(0x[0-9a-fA-F]+|\d+)\b").unwrap();
    let mut config_macros_vec: Vec<Value> = Vec::new();

    let total_files = target_files.len().max(1);
    for (idx, (disp, full_path, is_local)) in target_files.iter().enumerate() {
        let pct = 14 + ((idx * 24) / total_files) as u32;
        on_progress(
            pct,
            &format!("正在读取源码与宏定义 ({}/{})", idx + 1, total_files),
            disp,
        );
        if let Ok(content) = fs::read_to_string(full_path) {
            for caps in def_re.captures_iter(&content) {
                let m_name = caps[1].to_string();
                let m_raw = &caps[2];
                let val = if let Some(hex) = m_raw.strip_prefix("0x").or_else(|| m_raw.strip_prefix("0X")) {
                    u32::from_str_radix(hex, 16).ok()
                } else {
                    m_raw.parse::<u32>().ok()
                };
                if let Some(v) = val {
                    macros.insert(m_name.clone(), v);
                }
                if *is_local
                    && config_macros_vec.len() < 10
                    && !m_name.ends_with("_H")
                    && !m_name.starts_with("USE_HAL_")
                {
                    config_macros_vec.push(json!({
                        "name": m_name,
                        "defaultVal": m_raw,
                        "file": disp,
                        "purpose": format!("定义于 {} 的工程配置宏", disp)
                    }));
                }
            }
            files_content.insert(disp.clone(), content);
        }
    }

    on_progress(40, "正在构建 #include 头文件级联闭包...", "");

    // Build #include map
    let mut header_by_base: HashMap<String, String> = HashMap::new();
    for rel in files_content.keys() {
        if rel.ends_with(".h") || rel.ends_with(".hpp") {
            if let Some(base) = Path::new(rel).file_name().and_then(|s| s.to_str()) {
                header_by_base.insert(base.to_string(), rel.clone());
            }
        }
    }
    let inc_re = Regex::new(r#"#include\s+["<]([^">]+)[">]"#).unwrap();
    let mut file_includes: HashMap<String, Vec<String>> = HashMap::new();
    for (rel, content) in &files_content {
        let mut incs = Vec::new();
        for caps in inc_re.captures_iter(content) {
            let raw_inc = caps[1].replace('\\', "/");
            if files_content.contains_key(&raw_inc) {
                if !incs.contains(&raw_inc) {
                    incs.push(raw_inc);
                }
            } else if let Some(base) = Path::new(&raw_inc).file_name().and_then(|s| s.to_str()) {
                if let Some(mapped) = header_by_base.get(base) {
                    if !incs.contains(mapped) {
                        incs.push(mapped.clone());
                    }
                }
            }
        }
        file_includes.insert(rel.clone(), incs);
    }

    // Parse all functions and global variables
    let mut parsed_funcs: HashMap<String, ParsedFunc> = HashMap::new();
    let mut weak_names: HashSet<String> = HashSet::new();
    let mut globals_vec: Vec<Value> = Vec::new();
    let mut global_names: Vec<String> = Vec::new();

    for (idx, (disp, _, is_local)) in target_files.iter().enumerate() {
        if !disp.ends_with(".c") && !disp.ends_with(".cpp") {
            continue;
        }
        let pct = 44 + ((idx * 36) / total_files) as u32;
        on_progress(
            pct,
            &format!("正在解析 AST 函数、Doxygen注释与栈帧 ({}/{})", idx + 1, total_files),
            disp,
        );
        if let Some(content) = files_content.get(disp) {
            if *is_local && !is_cherry_usb {
                for g in parse_global_variables(disp, content, &macros) {
                    if let Some(gn) = g.get("name").and_then(|v| v.as_str()) {
                        if !global_names.contains(&gn.to_string()) {
                            global_names.push(gn.to_string());
                            globals_vec.push(g);
                        }
                    }
                }
            }

            for pf in parse_c_file_functions(disp, content, &macros, *is_local) {
                if is_syscall_boilerplate_file_or_fn(disp, &pf.name) {
                    continue;
                }
                if pf.is_weak {
                    weak_names.insert(pf.name.clone());
                }
                let replace = match parsed_funcs.get(&pf.name) {
                    None => true,
                    Some(ex) => {
                        if ex.file.starts_with("port/fsdev/") && disp.starts_with("port/dwc2/") {
                            false
                        } else if ex.file == "demo/cdc_acm_template.c" && disp.starts_with("demo/")
                        {
                            false
                        } else if ex.is_user_src && !pf.is_user_src {
                            false
                        } else {
                            (ex.is_weak && !pf.is_weak) || (!ex.is_user_src && pf.is_user_src)
                        }
                    }
                };
                if replace {
                    parsed_funcs.insert(pf.name.clone(), pf);
                }
            }
        }
    }

    on_progress(
        84,
        &format!("正在缝合调用链与隐式回调 ({} 个函数)...", parsed_funcs.len()),
        "",
    );

    // Build nodes JSON map
    let mut nodes_map = serde_json::Map::new();
    for (name, pf) in &parsed_funcs {
        let is_weak_sym = pf.is_weak || weak_names.contains(name);
        let layer = classify_layer(&pf.file, name, is_weak_sym);
        let brief = synthesize_meaningful_brief(pf, layer);

        let mut reads_globals = Vec::new();
        let mut writes_globals = Vec::new();
        for gname in &global_names {
            if pf.body.contains(gname) {
                reads_globals.push(gname.clone());
                if pf.body.contains(&format!("&{}", gname))
                    || pf.body.contains(&format!("{}.", gname))
                {
                    writes_globals.push(gname.clone());
                }
            }
        }

        nodes_map.insert(
            name.clone(),
            json!({
                "id": name,
                "name": name,
                "signature": pf.signature,
                "file": pf.file,
                "lineStart": pf.line_start,
                "lineEnd": pf.line_end,
                "layer": layer,
                "isCallback": layer == "CALLBACK",
                "isIsr": name.ends_with("_IRQHandler") || name == "SysTick_Handler",
                "hasStateMachine": pf.has_switch,
                "stackBytes": pf.stack_bytes,
                "localVars": pf.local_vars,
                "stackWarnings": if pf.stack_warnings.is_empty() { Value::Null } else { json!(pf.stack_warnings) },
                "readsGlobals": reads_globals,
                "writesGlobals": writes_globals,
                "callsHeap": pf.calls_heap,
                "heapApis": pf.heap_apis,
                "snippet": pf.snippet,
                "brief": brief,
            }),
        );
    }

    // For any user function calling external HAL / BSP / LL / SCB / __HAL macros not yet in nodes_map,
    // automatically synthesize external HAL boundary nodes so no hardware call is ever lost!
    if !is_cherry_usb {
        for pf in parsed_funcs.values().filter(|f| f.is_user_src) {
            for (callee, _, _) in &pf.direct_calls {
                if !nodes_map.contains_key(callee) && !is_trivial_c_std_call(callee) {
                    let low = callee.to_lowercase();
                    if low.starts_with("hal_")
                        || low.starts_with("__hal_")
                        || low.starts_with("bsp_")
                        || low.starts_with("ll_")
                        || low.starts_with("scb_")
                        || low.starts_with("nvic_")
                    {
                        let ext_brief = if low.contains("_clk_enable") {
                            format!("【RCC 硬件时钟宏】使能外设时钟 ({})", callee)
                        } else if low.starts_with("scb_enable") {
                            format!("【Cortex-M7 内核 Cache 接口】开启 CPU L1 缓存 ({})", callee)
                        } else if low.starts_with("bsp_led_") {
                            format!("【板级 BSP 接口】控制开发板状态指示灯 ({})", callee)
                        } else if low.starts_with("hal_mpu_") {
                            format!("【Cortex-M MPU 硬件接口】配置内存保护单元 ({})", callee)
                        } else {
                            format!("【底层 HAL/BSP 驱动接口】外部硬件操作函数 {}()", callee)
                        };
                        nodes_map.insert(
                            callee.clone(),
                            json!({
                                "id": callee,
                                "name": callee,
                                "signature": format!("void {}(...)", callee),
                                "file": "Drivers/CMSIS_or_HAL_Macro",
                                "lineStart": 1,
                                "lineEnd": 1,
                                "layer": "HAL",
                                "isExternal": true,
                                "stackBytes": 16,
                                "localVars": [],
                                "readsGlobals": [],
                                "writesGlobals": [],
                                "snippet": format!("/* Hardware Macro / External Driver Interface */\n{}(...);", callee),
                                "brief": ext_brief,
                            }),
                        );
                    }
                }
            }
        }
    }

    // Ensure external HAL nodes for CherryUSB
    if is_cherry_usb {
        let ext_hals = [
            (
                "usb_hc_init",
                "int usb_hc_init(struct usbh_bus *bus)",
                "common/usb_hc.h",
                "【HCD 硬件移植边界】初始化 USB Host 主机控制器寄存器与 DMA",
            ),
            (
                "usbh_roothub_control",
                "int usbh_roothub_control(struct usbh_bus *bus, struct usb_setup_packet *setup, uint8_t *buf)",
                "common/usb_hc.h",
                "【HCD 硬件移植边界】主机控制器 Roothub 端口状态查询与端口复位操作",
            ),
            (
                "usbh_submit_urb",
                "int usbh_submit_urb(struct usbh_urb *urb)",
                "common/usb_hc.h",
                "【HCD 硬件移植边界】向底层 USB 主机控制器提交 URB 传输请求块",
            ),
            (
                "usb_osal_malloc",
                "void *usb_osal_malloc(size_t size)",
                "common/usb_osal.h",
                "【OSAL 操作系统移植边界】动态分配堆内存",
            ),
        ];
        for (en, sig, f, br) in ext_hals {
            if !nodes_map.contains_key(en) {
                nodes_map.insert(
                    en.to_string(),
                    json!({
                        "id": en,
                        "name": en,
                        "signature": sig,
                        "file": f,
                        "lineStart": 1,
                        "lineEnd": 1,
                        "layer": "HAL",
                        "isExternal": true,
                        "stackBytes": 44,
                        "localVars": [],
                        "readsGlobals": [],
                        "writesGlobals": [],
                        "snippet": format!("/* Porting Boundary ({}) */\n{};", f, sig),
                        "brief": br,
                    }),
                );
            }
        }
    }

    // Build edges
    let mut edges_vec: Vec<Value> = Vec::new();
    let mut edge_keys: HashSet<String> = HashSet::new();
    let mut edge_seq = 1;

    let mut push_edge = |src: &str, tgt: &str, kind: &str, label: Option<String>, line: usize| {
        if src == tgt || !nodes_map.contains_key(src) || !nodes_map.contains_key(tgt) {
            return;
        }
        let k = format!("{}->{}", src, tgt);
        if edge_keys.insert(k) {
            edges_vec.push(json!({
                "id": format!("e_rs_{}", edge_seq),
                "source": src,
                "target": tgt,
                "kind": kind,
                "label": label,
                "callSiteLine": line,
            }));
            edge_seq += 1;
        }
    };

    for (name, pf) in &parsed_funcs {
        for (fa_field, fa_target, line) in &pf.field_assignments {
            push_edge(
                name,
                fa_target,
                "OPS_TABLE",
                Some(format!(".{} = {}", fa_field, fa_target)),
                *line,
            );
        }
        for (callee, line, args_text) in &pf.direct_calls {
            let is_weak_t = weak_names.contains(callee)
                || callee.ends_with("MspInit")
                || callee.ends_with("MspDeInit")
                || callee.ends_with("Callback")
                || parsed_funcs.get(callee).map(|f| f.is_weak).unwrap_or(false);
            push_edge(
                name,
                callee,
                if is_weak_t { "WEAK_OVERRIDE" } else { "DIRECT" },
                if is_weak_t {
                    Some("__weak 硬件/事件回调".into())
                } else {
                    None
                },
                *line,
            );
            for tok in args_text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_') {
                if !tok.is_empty() && tok != callee && nodes_map.contains_key(tok) {
                    push_edge(
                        name,
                        tok,
                        "ASYNC_CALLBACK",
                        Some(format!("注册回调 ({})", callee)),
                        *line,
                    );
                }
            }
        }
    }

    if is_cherry_usb {
        let curated = [
            ("usbd_desc_register", "device_descriptor_callback", "OPS_TABLE", "descriptors->device_descriptor_callback"),
            ("usbd_add_endpoint", "usbd_cdc_acm_bulk_out", "ASYNC_CALLBACK", "rx_msg[ep].cb = ep->ep_cb"),
            ("usbd_add_endpoint", "usbd_cdc_acm_bulk_in", "ASYNC_CALLBACK", "tx_msg[ep].cb = ep->ep_cb"),
            ("usbd_initialize", "usbd_event_handler", "ASYNC_CALLBACK", "g_usbd_core.event_handler(INIT)"),
            ("usbd_event_reset_handler", "device_descriptor_callback", "OPS_TABLE", "descriptors->device_descriptor_callback()"),
            ("usbd_set_configuration", "usbd_event_handler", "ASYNC_CALLBACK", "event_handler(CONFIGURED)"),
            ("usbd_class_request_handler", "cdc_acm_class_interface_request_handler", "OPS_TABLE", "intf->class_interface_handler()"),
            ("usbd_event_ep_out_complete_handler", "usbd_cdc_acm_bulk_out", "ASYNC_CALLBACK", "rx_msg[ep].cb()"),
            ("usbd_event_ep_in_complete_handler", "usbd_cdc_acm_bulk_in", "ASYNC_CALLBACK", "tx_msg[ep].cb()"),
            ("usbh_enumerate", "usbh_hub_connect", "OPS_TABLE", "CLASS_CONNECT (hub->connect)"),
            ("usbh_enumerate", "usbh_msc_connect", "OPS_TABLE", "CLASS_CONNECT (msc->connect)"),
        ];
        for (s, t, k, lbl) in curated {
            push_edge(s, t, k, Some(lbl.to_string()), 1);
        }
    }

    let edges_for_nodes = |nids: &[String]| -> Vec<String> {
        let set: HashSet<&String> = nids.iter().collect();
        edges_vec
            .iter()
            .filter_map(|e| {
                let s = e.get("source")?.as_str()?.to_string();
                let t = e.get("target")?.as_str()?.to_string();
                if set.contains(&s) && set.contains(&t) {
                    Some(e.get("id")?.as_str()?.to_string())
                } else {
                    None
                }
            })
            .collect()
    };

    let mut entries_vec = Vec::new();
    if is_cherry_usb {
        let preset_entries: Vec<(&str, &str, &str, &str, &str, Option<u32>, Vec<&str>)> = vec![
            (
                "cherry_usbd_irq_enum",
                "USBD_IRQHandler",
                "USB Device 中断枚举与端点回调全链路",
                "ISR",
                "CherryUSB Device 核心脉络：从 DCD 硬件中断 USBD_IRQHandler 出发，涵盖总线复位、EP0 标准枚举请求、Class 接口表回调、__WEAK 钩子重写及 Bulk IN/OUT 端点完成异步回调。",
                None,
                vec![
                    "USBD_IRQHandler",
                    "usbd_event_reset_handler",
                    "device_descriptor_callback",
                    "usbd_ep_open",
                    "usbd_event_ep0_setup_complete_handler",
                    "__usbd_event_ep0_setup_complete_handler",
                    "usbd_setup_request_handler",
                    "usbd_standard_request_handler",
                    "usbd_std_device_req_handler",
                    "usbd_get_descriptor",
                    "usbd_set_configuration",
                    "usbd_event_handler",
                    "usbd_class_request_handler",
                    "cdc_acm_class_interface_request_handler",
                    "usbd_cdc_acm_set_dtr",
                    "usbd_cdc_acm_set_line_coding",
                    "usbd_event_ep_out_complete_handler",
                    "usbd_cdc_acm_bulk_out",
                    "usbd_event_ep_in_complete_handler",
                    "usbd_cdc_acm_bulk_in",
                    "usbd_ep_start_read",
                    "usbd_ep_start_write",
                    "fsdev_read_pma",
                    "fsdev_write_pma",
                ],
            ),
            (
                "cherry_cdc_init",
                "cdc_acm_init",
                "USB Device CDC ACM 初始化与回调挂载链",
                "MAIN_LOOP",
                "展示应用层如何一步步把描述符回调表、类接口回调和端点收发回调注册进 core，并最终调用 DCD 移植接口 usb_dc_init。",
                None,
                vec![
                    "cdc_acm_init",
                    "usbd_desc_register",
                    "device_descriptor_callback",
                    "usbd_cdc_acm_init_intf",
                    "cdc_acm_class_interface_request_handler",
                    "usbd_add_interface",
                    "usbd_add_endpoint",
                    "usbd_cdc_acm_bulk_out",
                    "usbd_cdc_acm_bulk_in",
                    "usbd_initialize",
                    "usbd_class_event_notify_handler",
                    "usbd_event_handler",
                    "usbd_ep_start_read",
                    "usb_dc_init",
                    "usb_dc_low_level_init",
                ],
            ),
            (
                "cherry_usbh_hub_thread",
                "usbh_hub_thread",
                "USB Host 主机栈 Hub 热插拔与设备枚举线程",
                "RTOS_TASK",
                "CherryUSB Host 核心 RTOS 线程：通过 OSAL 消息队列监听端口变化，执行复位、EP0 控制传输枚举、动态堆分配 raw_config_desc 并通过 CLASS_CONNECT 挂载驱动。",
                Some(2048),
                vec![
                    "usbh_hub_thread",
                    "usb_hc_init",
                    "usb_osal_mq_recv",
                    "usbh_hub_events",
                    "usbh_hub_get_portstatus",
                    "usbh_hub_set_feature",
                    "usbh_roothub_control",
                    "usbh_enumerate",
                    "usbh_control_transfer",
                    "parse_device_descriptor",
                    "parse_config_descriptor",
                    "usb_osal_malloc",
                    "usbh_get_string_desc",
                    "usbh_submit_urb",
                    "usbh_hub_connect",
                    "usbh_msc_connect",
                ],
            ),
            (
                "cherry_usbd_msc_bot",
                "mass_storage_bulk_out",
                "USB Device MSC 大容量存储 BOT 状态机",
                "PUBLIC_API",
                "USB 虚拟 U 盘核心协议栈：解析 31 字节 CBW 命令块、执行 SCSI 指令集，并通过 __WEAK 钩子与底层 Flash/SD 卡存储介质解耦。",
                None,
                vec![
                    "mass_storage_bulk_out",
                    "SCSI_CBWDecode",
                    "SCSI_inquiry",
                    "SCSI_readCapacity10",
                    "SCSI_read10",
                    "SCSI_write10",
                    "SCSI_processRead",
                    "SCSI_processWrite",
                    "usbd_msc_sector_read",
                    "usbd_msc_sector_write",
                    "usbd_msc_send_csw",
                    "usbd_ep_start_write",
                ],
            ),
            (
                "cherry_lsusb_cmd",
                "lsusb",
                "lsusb 命令行工具（含级联 Hub 直接递归）",
                "CMD_TABLE",
                "CherryUSB 内置 Shell 诊断命令：其中 usbh_list_device 在遇到子 Hub 时存在真实的直接递归调用（每层分配 imbuf[64]+ipbuf[64] 栈缓冲）。",
                None,
                vec![
                    "lsusb",
                    "lsusb_help",
                    "usbh_list_device",
                    "usbh_print_hubport_info",
                    "usbh_get_string_desc",
                    "usbh_control_transfer",
                    "usbh_submit_urb",
                ],
            ),
        ];

        for (id, name, disp, cat, sum, rtos_stk, raw_nids) in preset_entries {
            let nids: Vec<String> = raw_nids
                .into_iter()
                .filter(|n| nodes_map.contains_key(*n))
                .map(|s| s.to_string())
                .collect();
            let eids = edges_for_nodes(&nids);
            let steps: Vec<Value> = nids
                .iter()
                .take(4)
                .enumerate()
                .map(|(idx, nid)| {
                    json!({
                        "id": format!("{}_s_{}", id, idx),
                        "stage": format!("阶段 {}", idx + 1),
                        "title": format!("{}()", nid),
                        "nodeId": nid,
                        "detail": nodes_map.get(nid).and_then(|v| v.get("brief")).and_then(|b| b.as_str()).unwrap_or(""),
                        "tag": "FSM"
                    })
                })
                .collect();
            entries_vec.push(json!({
                "id": id,
                "name": name,
                "displayName": disp,
                "category": cat,
                "entryNodeId": name,
                "rtosAllocatedStackBytes": rtos_stk,
                "summary": sum,
                "nodeIds": nids,
                "edgeIds": eids,
                "configMacros": config_macros_vec,
                "staticFlowOutline": steps,
            }));
        }
    } else {
        // Generic C/C++ project: Deep, domain-intelligent entry and phased execution flow extraction!
        let readme_summary = extract_project_readme_summary(root_path);
        let mut adj: HashMap<String, Vec<String>> = HashMap::new();
        for k in nodes_map.keys() {
            adj.insert(k.clone(), Vec::new());
        }
        for e in &edges_vec {
            if let (Some(s), Some(t)) = (
                e.get("source").and_then(|v| v.as_str()),
                e.get("target").and_then(|v| v.as_str()),
            ) {
                if let Some(list) = adj.get_mut(s) {
                    list.push(t.to_string());
                }
            }
        }

        let collect_bfs = |root_id: &str, max_nodes: usize| -> Vec<String> {
            let mut visited = Vec::new();
            let mut seen = HashSet::new();
            let mut q = VecDeque::new();
            seen.insert(root_id.to_string());
            visited.push(root_id.to_string());
            q.push_back(root_id.to_string());

            while let Some(curr) = q.pop_front() {
                if visited.len() >= max_nodes {
                    break;
                }
                if let Some(neighbors) = adj.get(&curr) {
                    for nxt in neighbors {
                        if seen.insert(nxt.clone()) {
                            visited.push(nxt.clone());
                            q.push_back(nxt.clone());
                            if visited.len() >= max_nodes {
                                break;
                            }
                        }
                    }
                }
            }
            visited
        };

        // 1. Always place `main` first if present, prioritizing business/peripheral subtrees in BFS!
        if let Some(main_pf) = parsed_funcs.get("main") {
            let mut nids = vec!["main".to_string()];
            let mut seen_m: HashSet<String> = HashSet::from(["main".to_string()]);
            // Direct children of main first
            if let Some(main_children) = adj.get("main") {
                for ch in main_children {
                    if seen_m.insert(ch.clone()) {
                        nids.push(ch.clone());
                    }
                }
            }
            // Prioritize expanding business peripheral calls (e.g. HAL_CRYP_*) before boilerplate clock/init calls
            let mut priority_q: VecDeque<String> = VecDeque::new();
            let mut secondary_q: VecDeque<String> = VecDeque::new();
            for ch in nids.iter().skip(1) {
                if matches!(
                    ch.as_str(),
                    "HAL_Init" | "SystemClock_Config" | "MPU_Config" | "CPU_CACHE_Enable" | "Error_Handler"
                ) {
                    secondary_q.push_back(ch.clone());
                } else {
                    priority_q.push_back(ch.clone());
                }
            }
            priority_q.extend(secondary_q);

            while let Some(curr) = priority_q.pop_front() {
                if nids.len() >= 30 {
                    break;
                }
                if let Some(neighbors) = adj.get(&curr) {
                    for nxt in neighbors {
                        if seen_m.insert(nxt.clone()) {
                            nids.push(nxt.clone());
                            priority_q.push_back(nxt.clone());
                            if nids.len() >= 30 {
                                break;
                            }
                        }
                    }
                }
            }

            let eids = edges_for_nodes(&nids);

            let mut outline_steps: Vec<Value> = Vec::new();
            let active_phases: Vec<&InlinePhase> = main_pf
                .inline_phases
                .iter()
                .filter(|p| !p.calls.is_empty() || !p.configs.is_empty())
                .collect();
            if !active_phases.is_empty() {
                for (p_idx, phase) in active_phases.iter().enumerate() {
                    let focus_node = phase
                        .calls
                        .first()
                        .cloned()
                        .unwrap_or_else(|| "main".to_string());
                    let calls_str = if phase.calls.is_empty() {
                        "配置外设句柄参数".to_string()
                    } else {
                        phase.calls.join(" ➔ ")
                    };
                    let cfg_str = if phase.configs.is_empty() {
                        String::new()
                    } else {
                        format!(" [参数: {}]", phase.configs.join(", "))
                    };
                    outline_steps.push(json!({
                        "id": format!("main_phase_{}", p_idx),
                        "stage": format!("阶段 {}: {}", p_idx + 1, phase.title),
                        "title": calls_str,
                        "nodeId": if nodes_map.contains_key(&focus_node) { focus_node } else { "main".to_string() },
                        "detail": format!("执行 {}{}", phase.calls.join(" / "), cfg_str),
                        "tag": if p_idx == 0 { "INIT" } else { "FSM" }
                    }));
                }
            }

            if outline_steps.is_empty() {
                for (s_idx, nid) in nids.iter().take(6).enumerate() {
                    outline_steps.push(json!({
                        "id": format!("main_s_{}", s_idx),
                        "stage": format!("步骤 {}", s_idx + 1),
                        "title": format!("{}()", nid),
                        "nodeId": nid,
                        "detail": nodes_map.get(nid).and_then(|v| v.get("brief")).and_then(|b| b.as_str()).unwrap_or(""),
                        "tag": "FSM"
                    }));
                }
            }

            let main_summary = readme_summary.clone().unwrap_or_else(|| {
                nodes_map
                    .get("main")
                    .and_then(|v| v.get("brief"))
                    .and_then(|b| b.as_str())
                    .unwrap_or("主程序入口完整初始化与业务执行链路")
                    .to_string()
            });

            entries_vec.push(json!({
                "id": "entry_main_full",
                "name": "main",
                "displayName": "main() — 工程主业务流程与硬件驱动全链路",
                "category": "MAIN_LOOP",
                "entryNodeId": "main",
                "summary": main_summary,
                "nodeIds": nids,
                "edgeIds": eids,
                "configMacros": config_macros_vec,
                "staticFlowOutline": outline_steps,
            }));

            // 2. Also create focused sub-entries for each major business API called inside main()
            // (e.g. HAL_CRYP_Init, HAL_CRYP_Encrypt, HAL_CRYP_Decrypt, HAL_CRYPEx_AESGCM_GenerateAuthTAG, SystemClock_Config)
            for (callee, _, _) in &main_pf.direct_calls {
                if matches!(
                    callee.as_str(),
                    "Error_Handler" | "HAL_Init" | "MPU_Config" | "CPU_CACHE_Enable"
                ) || is_trivial_c_std_call(callee)
                {
                    continue;
                }
                if nodes_map.contains_key(callee) {
                    let sub_nids = collect_bfs(callee, 18);
                    if sub_nids.len() >= 2 {
                        let sub_eids = edges_for_nodes(&sub_nids);
                        let brief_str = nodes_map
                            .get(callee)
                            .and_then(|v| v.get("brief"))
                            .and_then(|b| b.as_str())
                            .unwrap_or("");
                        let steps: Vec<Value> = sub_nids
                            .iter()
                            .take(5)
                            .enumerate()
                            .map(|(s_idx, nid)| {
                                json!({
                                    "id": format!("sub_{}_{}", callee, s_idx),
                                    "stage": format!("调用层级 {}", s_idx + 1),
                                    "title": format!("{}()", nid),
                                    "nodeId": nid,
                                    "detail": nodes_map.get(nid).and_then(|v| v.get("brief")).and_then(|b| b.as_str()).unwrap_or(""),
                                    "tag": "FSM"
                                })
                            })
                            .collect();
                        entries_vec.push(json!({
                            "id": format!("entry_sub_{}", callee),
                            "name": callee,
                            "displayName": format!("{}() 子系统深层实现链路", callee),
                            "category": if callee.contains("Clock") || callee.contains("Init") { "MAIN_LOOP" } else { "PUBLIC_API" },
                            "entryNodeId": callee,
                            "summary": brief_str,
                            "nodeIds": sub_nids,
                            "edgeIds": sub_eids,
                            "configMacros": config_macros_vec,
                            "staticFlowOutline": steps,
                        }));
                    }
                }
            }
        }

        // 3. Add non-empty ISR / MSP Callback entries (e.g. HAL_CRYP_MspInit, SysTick_Handler, *_IRQHandler)
        for (name, pf) in &parsed_funcs {
            if !pf.is_user_src || name == "main" {
                continue;
            }
            let is_msp_or_isr = name.ends_with("MspInit")
                || name.ends_with("_IRQHandler")
                || name == "SysTick_Handler";
            if is_msp_or_isr && !pf.direct_calls.is_empty() {
                let nids = collect_bfs(name, 14);
                let eids = edges_for_nodes(&nids);
                let brief_str = nodes_map
                    .get(name)
                    .and_then(|v| v.get("brief"))
                    .and_then(|b| b.as_str())
                    .unwrap_or("");
                entries_vec.push(json!({
                    "id": format!("entry_isr_{}", name),
                    "name": name,
                    "displayName": format!("{}() 硬件回调/中断入口", name),
                    "category": "ISR",
                    "entryNodeId": name,
                    "summary": brief_str,
                    "nodeIds": nids,
                    "edgeIds": eids,
                    "configMacros": config_macros_vec,
                    "staticFlowOutline": [
                        {
                            "id": format!("isr_step_{}", name),
                            "stage": "中断/MSP 回调触发",
                            "title": format!("{}()", name),
                            "nodeId": name,
                            "detail": brief_str,
                            "tag": "CALLBACK"
                        }
                    ],
                }));
            }
        }

        // 4. Fallback if project has no `main` (e.g. a pure driver/middleware library)
        if entries_vec.is_empty() {
            let mut candidates: Vec<(String, Vec<String>)> = nodes_map
                .keys()
                .map(|k| (k.clone(), collect_bfs(k, 24)))
                .filter(|(_, v)| v.len() >= 2)
                .collect();
            candidates.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
            for (idx, (root_id, nids)) in candidates.into_iter().take(8).enumerate() {
                let eids = edges_for_nodes(&nids);
                let brief_str = nodes_map
                    .get(&root_id)
                    .and_then(|v| v.get("brief"))
                    .and_then(|b| b.as_str())
                    .unwrap_or("");
                let steps: Vec<Value> = nids
                    .iter()
                    .take(5)
                    .enumerate()
                    .map(|(s_idx, nid)| {
                        json!({
                            "id": format!("fb_{}_{}", idx, s_idx),
                            "stage": format!("步骤 {}", s_idx + 1),
                            "title": format!("{}()", nid),
                            "nodeId": nid,
                            "detail": nodes_map.get(nid).and_then(|v| v.get("brief")).and_then(|b| b.as_str()).unwrap_or(""),
                            "tag": "FSM"
                        })
                    })
                    .collect();
                entries_vec.push(json!({
                    "id": format!("gen_entry_{}", idx),
                    "name": root_id,
                    "displayName": format!("{}() 功能调用链", root_id),
                    "category": "PUBLIC_API",
                    "entryNodeId": root_id,
                    "summary": brief_str,
                    "nodeIds": nids,
                    "edgeIds": eids,
                    "configMacros": config_macros_vec,
                    "staticFlowOutline": steps,
                }));
            }
        }
    }

    on_progress(100, "静态解析完成！", "");

    let proj_name = root_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Embedded_Project");

    Ok(json!({
        "projectName": proj_name,
        "archBits": 32,
        "targetMcuHint": format!("Real Local Repo ({})", root_dir),
        "sourceKind": "LOCAL_WORKSPACE",
        "runtimeParadigm": if is_cherry_usb { "HYBRID_OPTIONAL_OS" } else { "BARE_METAL" },
        "detectedMspStackBytes": detected_msp_stack_bytes,
        "mspStackSource": msp_stack_source,
        "fileIncludes": file_includes,
        "files": files_content,
        "nodes": nodes_map,
        "edges": edges_vec,
        "globals": globals_vec,
        "entries": entries_vec,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPortingPayload {
    pub repo_path: String,
    pub target_dir: Option<String>,
    pub feature_name: String,
    pub files_to_copy: Vec<String>,
    pub adapter_file_name: String,
    pub adapter_code: String,
    pub porting_guide_md: String,
    pub project_files: Option<HashMap<String, String>>,
}

pub fn export_porting_bundle(payload: ExportPortingPayload) -> Result<Value, String> {
    let out_base: PathBuf = match payload
        .target_dir
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        Some(custom) => PathBuf::from(custom),
        None => std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("exported_ports")
            .join(format!("port_{}", payload.feature_name)),
    };

    fs::create_dir_all(&out_base).map_err(|e| e.to_string())?;
    let mut copied_files = Vec::new();
    let mut files_set: HashSet<String> = payload.files_to_copy.into_iter().collect();

    let repo_root = Path::new(&payload.repo_path);
    if repo_root.join("common").exists() {
        if let Ok(rd) = fs::read_dir(repo_root.join("common")) {
            for entry in rd.flatten() {
                let fname = entry.file_name().to_string_lossy().to_string();
                if fname.ends_with(".h") {
                    files_set.insert(format!("common/{}", fname));
                }
            }
        }
    }

    for rel in files_set {
        let dest = out_base.join(&rel);
        if let Some(parent) = dest.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let src_disk = repo_root.join(&rel);
        if src_disk.exists() {
            if fs::copy(&src_disk, &dest).is_ok() {
                copied_files.push(rel);
            }
        } else if let Some(content) = payload.project_files.as_ref().and_then(|m| m.get(&rel)) {
            if fs::write(&dest, content).is_ok() {
                copied_files.push(rel);
            }
        }
    }

    let adapter_path = out_base.join(&payload.adapter_file_name);
    fs::write(&adapter_path, &payload.adapter_code).map_err(|e| e.to_string())?;
    copied_files.push(payload.adapter_file_name);

    let guide_path = out_base.join("PORTING_CHECKLIST.md");
    fs::write(&guide_path, &payload.porting_guide_md).map_err(|e| e.to_string())?;
    copied_files.push("PORTING_CHECKLIST.md".to_string());

    Ok(json!({
        "ok": true,
        "outputDir": out_base.to_string_lossy(),
        "copiedCount": copied_files.len(),
        "copiedFiles": copied_files,
    }))
}
