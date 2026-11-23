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
struct ParsedFunc {
    name: String,
    signature: String,
    file: String,
    line_start: usize,
    line_end: usize,
    is_weak: bool,
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
        "uint8_t" | "int8_t" | "char" | "bool" => Some(1),
        "uint16_t" | "int16_t" | "short" => Some(2),
        "uint32_t" | "int32_t" | "int" | "long" | "float" | "uintptr_t" | "size_t" => Some(4),
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
        _ => None,
    }
}

fn classify_layer(rel_file: &str, fn_name: &str, is_weak: bool) -> &'static str {
    let low_file = rel_file.to_lowercase();
    let low_name = fn_name.to_lowercase();

    if low_file.starts_with("port/")
        || low_file.starts_with("osal/")
        || low_file.starts_with("platform/")
        || low_file.starts_with("drivers/")
        || low_name.starts_with("usb_dc_")
        || low_name.starts_with("usb_hc_")
        || low_name.starts_with("usb_osal_")
        || low_name.starts_with("hal_")
        || low_name.starts_with("bsp_")
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

    if is_weak
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

    if low_file.starts_with("demo/")
        || low_file.starts_with("app/")
        || low_file.starts_with("tests/")
        || low_name == "main"
        || low_name == "lsusb"
    {
        return "APP";
    }

    "CORE"
}

fn parse_c_file_functions(
    rel_file: &str,
    content: &str,
    macros: &HashMap<String, u32>,
) -> Vec<ParsedFunc> {
    static FN_RE: OnceLock<Regex> = OnceLock::new();
    static ARR_RE: OnceLock<Regex> = OnceLock::new();
    static VAR_RE: OnceLock<Regex> = OnceLock::new();
    static CASE_RE: OnceLock<Regex> = OnceLock::new();
    static ASSIGN_RE: OnceLock<Regex> = OnceLock::new();
    static FIELD_CALL_RE: OnceLock<Regex> = OnceLock::new();
    static CALL_RE: OnceLock<Regex> = OnceLock::new();

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
        CALL_RE.get_or_init(|| Regex::new(r"\b([a-zA-Z_]\w*)\s*\(([^)]*)\)").unwrap());

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
                for ch in l.chars() {
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

            let body_lines = &lines[(brace_idx + 1)..end_idx];
            let body = body_lines.join("\n");

            let snippet_lines: Vec<&str> = body_lines
                .iter()
                .copied()
                .filter(|l| {
                    let t = l.trim();
                    !t.is_empty()
                        && !t.starts_with("//")
                        && !t.starts_with("/*")
                        && !t.starts_with('*')
                })
                .take(11)
                .collect();
            let snippet = if snippet_lines.is_empty() {
                before_brace.to_string()
            } else {
                snippet_lines.join("\n")
            };

            let is_weak = before_brace.contains("__WEAK") || before_brace.contains("__weak");
            let is_isr = fn_name.ends_with("_IRQHandler");
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
            let mut seen_callees = HashSet::new();
            let mut seen_fcalls = HashSet::new();
            let mut heap_apis = Vec::new();

            for (offset, b_line) in body_lines.iter().enumerate() {
                let clean = b_line.split("//").next().unwrap_or("");
                let line_num = brace_idx + 2 + offset;

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
                    let callee = cm[1].to_string();
                    let args_text = cm[2].to_string();
                    if is_c_keyword(&callee) {
                        continue;
                    }
                    if is_heap_api(&callee) && !heap_apis.contains(&callee) {
                        heap_apis.push(callee.clone());
                    }
                    if seen_callees.insert(callee.clone()) {
                        direct_calls.push((callee, line_num, args_text));
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

pub fn analyze_local_c_project_with_progress<F>(
    root_dir: &str,
    mut on_progress: F,
) -> Result<Value, String>
where
    F: FnMut(u32, &str, &str),
{
    on_progress(5, "正在扫描工程目录结构...", root_dir);
    let root_path = Path::new(root_dir);
    if !root_path.exists() {
        return Err(format!("目录不存在: {}", root_dir));
    }

    let is_cherry_usb = root_path.join("core").join("usbd_core.c").exists()
        && root_path.join("core").join("usbh_core.c").exists();

    let mut target_rel_files = Vec::new();
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
            if root_path.join(f).exists() {
                target_rel_files.push(f.to_string());
            }
        }
    } else {
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
            })
            .flatten()
        {
            if target_rel_files.len() >= 90 {
                break;
            }
            if entry.file_type().is_file() {
                let p = entry.path();
                if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
                    if matches!(ext, "c" | "cpp" | "h" | "hpp") {
                        if let Ok(rel) = p.strip_prefix(root_path) {
                            target_rel_files.push(rel.to_string_lossy().replace('\\', "/"));
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

    let def_re = Regex::new(r"#define\s+([A-Z0-9_]+)\s+(\d+)\b").unwrap();

    let total_files = target_rel_files.len().max(1);
    for (idx, rel) in target_rel_files.iter().enumerate() {
        let pct = 12 + ((idx * 25) / total_files) as u32;
        on_progress(
            pct,
            &format!("正在读取源码与宏定义 ({}/{})", idx + 1, total_files),
            rel,
        );
        if let Ok(content) = fs::read_to_string(root_path.join(rel)) {
            for caps in def_re.captures_iter(&content) {
                if let Ok(v) = caps[2].parse::<u32>() {
                    macros.insert(caps[1].to_string(), v);
                }
            }
            files_content.insert(rel.clone(), content);
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

    let mut parsed_funcs: HashMap<String, ParsedFunc> = HashMap::new();
    let mut weak_names: HashSet<String> = HashSet::new();

    for (idx, rel) in target_rel_files.iter().enumerate() {
        if !rel.ends_with(".c") && !rel.ends_with(".cpp") {
            continue;
        }
        let pct = 45 + ((idx * 35) / total_files) as u32;
        on_progress(
            pct,
            &format!("正在解析 AST 函数与栈帧 ({}/{})", idx + 1, total_files),
            rel,
        );
        if let Some(content) = files_content.get(rel) {
            for pf in parse_c_file_functions(rel, content, &macros) {
                if pf.is_weak {
                    weak_names.insert(pf.name.clone());
                }
                let replace = match parsed_funcs.get(&pf.name) {
                    None => true,
                    Some(ex) => {
                        if ex.file.starts_with("port/fsdev/") && rel.starts_with("port/dwc2/") {
                            false
                        } else if ex.file == "demo/cdc_acm_template.c" && rel.starts_with("demo/")
                        {
                            false
                        } else {
                            ex.is_weak && !pf.is_weak
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
        let brief = if !pf.switch_cases.is_empty() {
            format!(
                "状态机/分支 ({}) — {}:{}",
                pf.switch_cases
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", "),
                pf.file,
                pf.line_start
            )
        } else {
            format!("定义于 {}:{} 的 {} 层函数", pf.file, pf.line_start, layer)
        };

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
                "isIsr": name.ends_with("_IRQHandler"),
                "hasStateMachine": pf.has_switch,
                "stackBytes": pf.stack_bytes,
                "localVars": pf.local_vars,
                "stackWarnings": if pf.stack_warnings.is_empty() { Value::Null } else { json!(pf.stack_warnings) },
                "readsGlobals": [],
                "writesGlobals": [],
                "callsHeap": pf.calls_heap,
                "heapApis": pf.heap_apis,
                "snippet": pf.snippet,
                "brief": brief,
            }),
        );
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
        if !nodes_map.contains_key(src) || !nodes_map.contains_key(tgt) {
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
        for ( fa_field, fa_target, line) in &pf.field_assignments {
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
                || parsed_funcs.get(callee).map(|f| f.is_weak).unwrap_or(false);
            push_edge(
                name,
                callee,
                if is_weak_t { "WEAK_OVERRIDE" } else { "DIRECT" },
                if is_weak_t {
                    Some("__WEAK 钩子".into())
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
            ("usbh_list_device", "usbh_list_device", "ASYNC_CALLBACK", "级联 Hub 树直接递归遍历"),
        ];
        for (s, t, k, lbl) in curated {
            push_edge(s, t, k, Some(lbl.to_string()), 1);
        }
    }

    // Build entries
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
                "configMacros": [],
                "staticFlowOutline": steps,
            }));
        }
    } else {
        // Generic C/C++ project: automatically discover top entry functions by reachability
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

        let mut candidates: Vec<(String, Vec<String>)> = Vec::new();
        for root_id in nodes_map.keys() {
            let mut visited = Vec::new();
            let mut seen = HashSet::new();
            let mut q = VecDeque::new();
            seen.insert(root_id.clone());
            visited.push(root_id.clone());
            q.push_back(root_id.clone());

            while let Some(curr) = q.pop_front() {
                if visited.len() >= 28 {
                    break;
                }
                if let Some(neighbors) = adj.get(&curr) {
                    for nxt in neighbors {
                        if seen.insert(nxt.clone()) {
                            visited.push(nxt.clone());
                            q.push_back(nxt.clone());
                        }
                    }
                }
            }
            if visited.len() >= 2 {
                candidates.push((root_id.clone(), visited));
            }
        }

        candidates.sort_by(|a, b| b.1.len().cmp(&a.1.len()));
        for (idx, (root_id, nids)) in candidates.into_iter().take(10).enumerate() {
            let eids = edges_for_nodes(&nids);
            let low = root_id.to_lowercase();
            let cat = if root_id.ends_with("_IRQHandler") {
                "ISR"
            } else if low.contains("thread") || low.contains("task") {
                "RTOS_TASK"
            } else if low == "main" || low.contains("init") {
                "MAIN_LOOP"
            } else {
                "PUBLIC_API"
            };
            let file_str = nodes_map
                .get(&root_id)
                .and_then(|v| v.get("file"))
                .and_then(|f| f.as_str())
                .unwrap_or("");
            let steps: Vec<Value> = nids
                .iter()
                .take(5)
                .enumerate()
                .map(|(s_idx, nid)| {
                    json!({
                        "id": format!("gen_{}_{}", idx, s_idx),
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
                "displayName": format!("{}() 调用链", root_id),
                "category": cat,
                "entryNodeId": root_id,
                "summary": format!("自动从 {} 提取的调用子图（共关联 {} 个函数节点）", file_str, nids.len()),
                "nodeIds": nids,
                "edgeIds": eids,
                "configMacros": [],
                "staticFlowOutline": steps,
            }));
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
        "detectedMspStackBytes": 1024,
        "mspStackSource": "裸机主栈基准 (MSP Stack_Size = 0x0400 / 1024B)",
        "fileIncludes": file_includes,
        "files": files_content,
        "nodes": nodes_map,
        "edges": edges_vec,
        "globals": [],
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
    let out_base: PathBuf = match payload.target_dir.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
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
