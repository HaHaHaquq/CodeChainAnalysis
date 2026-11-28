use std::collections::{HashMap, HashSet};
use tree_sitter::{Node, Parser};

/// Normalized storage slot key for function pointers & callbacks.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SlotKey {
    /// Global or file-static function pointer variable, e.g. `g_rx_cb`
    GlobalVar(String),
    /// Named variable or array member, e.g. `g_ctx.rx_cb` or `rx_msg[ep].cb` -> ("rx_msg", "cb")
    VarField(String, String),
    /// Typed struct field, e.g. `UART_HandleTypeDef.RxCpltCallback`
    StructField(String, String),
    /// Unqualified struct field fallback, e.g. `.RxCpltCallback`
    FieldOnly(String),
}

impl SlotKey {
    pub fn display_label(&self) -> String {
        match self {
            SlotKey::GlobalVar(v) => v.clone(),
            SlotKey::VarField(v, f) => format!("{}.{}", v, f),
            SlotKey::StructField(t, f) => format!("{}.{}", t, f),
            SlotKey::FieldOnly(f) => format!(".{}", f),
        }
    }
}

#[derive(Debug, Clone)]
pub struct AstParam {
    pub index: usize,
    pub name: String,
    pub type_name: Option<String>,
    pub is_fn_ptr: bool,
}

#[derive(Debug, Clone)]
pub struct AstLocalDecl {
    pub name: String,
    pub type_str: String,
    pub base_type: String,
    pub is_ptr: bool,
    pub is_static: bool,
    pub array_dim_raw: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AstCallArg {
    pub index: usize,
    pub raw_text: String,
    /// Extracted bare identifier if the argument is `fn`, `&fn`, or `(cast)fn`
    pub ident: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AstDirectCall {
    pub callee: String,
    pub line: usize,
    pub expr: String,
    pub args_text: String,
    pub args: Vec<AstCallArg>,
    pub conditions: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AstIndirectCall {
    /// Immediate receiver name if member call (e.g. `class_cb`, `huart`, `rx_msg`),
    /// or variable name if direct fp variable call (`g_rx_cb()`).
    pub receiver: String,
    /// Member field name if `recv->field()` / `recv.field()`, None if `fp_var()`.
    pub field: Option<String>,
    /// If calling one of this function's own parameters directly (`cb(arg)`), its param index.
    pub callee_param_index: Option<usize>,
    /// Candidate normalized slot keys ordered from most specific to least specific.
    pub slot_keys: Vec<SlotKey>,
    pub line: usize,
    pub expr: String,
    pub conditions: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AstSlotWrite {
    pub lhs_slots: Vec<SlotKey>,
    pub lhs_field: Option<String>,
    pub rhs_ident: String,
    pub rhs_param_index: Option<usize>,
    pub line: usize,
    pub expr: String,
    pub conditions: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AstSlotCopy {
    pub dst_slots: Vec<SlotKey>,
    pub src_slots: Vec<SlotKey>,
    pub line: usize,
    pub expr: String,
}

#[derive(Debug, Clone)]
pub struct AstParamForward {
    pub param_index: usize,
    pub callee: String,
    pub callee_arg_index: usize,
    pub line: usize,
    pub expr: String,
}

#[derive(Debug, Clone)]
pub struct AstFunction {
    pub name: String,
    pub signature: String,
    pub file: String,
    pub line_start: usize,
    pub line_end: usize,
    pub body_start_line: usize,
    pub body_end_line: usize,
    pub is_weak: bool,
    pub is_static: bool,
    pub params: Vec<AstParam>,
    pub local_decls: Vec<AstLocalDecl>,
    pub has_switch: bool,
    pub switch_cases: Vec<String>,
    pub direct_calls: Vec<AstDirectCall>,
    pub indirect_calls: Vec<AstIndirectCall>,
    pub slot_writes: Vec<AstSlotWrite>,
    pub slot_copies: Vec<AstSlotCopy>,
    pub param_forwards: Vec<AstParamForward>,
    pub config_assignments: Vec<String>,
}

// ============================================================================
// 1. Line-preserving lightweight #ifdef / #ifndef / #if branch pruner
// ============================================================================

#[derive(Debug, Clone, Copy)]
enum BranchState {
    Active,
    Inactive,
    /// Unknown condition: conservatively keep active so we never silently lose code
    UnknownKeep,
}

#[derive(Debug, Clone, Copy)]
struct PpFrame {
    parent_active: bool,
    current: BranchState,
    taken_any: bool,
}

/// Evaluate a simple C preprocessor condition against known project defines.
/// Returns `Some(true)` / `Some(false)` when definitively decidable, or `None` if unknown.
fn eval_pp_expr(expr: &str, defines: &HashMap<String, Option<String>>, strict_ifdef: bool) -> Option<bool> {
    let s = strip_inline_comment(expr).trim();
    if s.is_empty() {
        return None;
    }
    // Strip balanced outer parentheses
    let s = strip_outer_parens(s);

    // Handle `||` at top level
    if let Some((lhs, rhs)) = split_top_level(s, "||") {
        let l = eval_pp_expr(lhs, defines, strict_ifdef);
        let r = eval_pp_expr(rhs, defines, strict_ifdef);
        return match (l, r) {
            (Some(true), _) | (_, Some(true)) => Some(true),
            (Some(false), Some(false)) => Some(false),
            _ => None,
        };
    }

    // Handle `&&` at top level
    if let Some((lhs, rhs)) = split_top_level(s, "&&") {
        let l = eval_pp_expr(lhs, defines, strict_ifdef);
        let r = eval_pp_expr(rhs, defines, strict_ifdef);
        return match (l, r) {
            (Some(false), _) | (_, Some(false)) => Some(false),
            (Some(true), Some(true)) => Some(true),
            _ => None,
        };
    }

    // Handle unary `!`
    if let Some(rest) = s.strip_prefix('!') {
        return eval_pp_expr(rest.trim(), defines, strict_ifdef).map(|v| !v);
    }

    // Handle `defined(NAME)` or `defined NAME`
    if let Some(rest) = s.strip_prefix("defined") {
        let after = rest.trim();
        if after.starts_with('(') || rest.starts_with(char::is_whitespace) {
            let ident = after.trim_start_matches('(').trim_end_matches(')').trim();
            if is_ident(ident) {
                if defines.contains_key(ident) {
                    return Some(true);
                }
                return if strict_ifdef { Some(false) } else { None };
            }
        }
    }

    // Handle `==` and `!=`
    if let Some((lhs, rhs)) = split_top_level(s, "==") {
        let l = eval_pp_int(lhs, defines)?;
        let r = eval_pp_int(rhs, defines)?;
        return Some(l == r);
    }
    if let Some((lhs, rhs)) = split_top_level(s, "!=") {
        let l = eval_pp_int(lhs, defines)?;
        let r = eval_pp_int(rhs, defines)?;
        return Some(l != r);
    }

    // Plain integer or macro name
    if let Some(num) = eval_pp_int(s, defines) {
        return Some(num != 0);
    }

    None
}

fn eval_pp_int(tok: &str, defines: &HashMap<String, Option<String>>) -> Option<i64> {
    let t = strip_outer_parens(tok.trim());
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        let clean = hex.trim_end_matches(|c| matches!(c, 'u' | 'U' | 'l' | 'L'));
        return i64::from_str_radix(clean, 16).ok();
    }
    let clean_dec = t.trim_end_matches(|c| matches!(c, 'u' | 'U' | 'l' | 'L'));
    if let Ok(n) = clean_dec.parse::<i64>() {
        return Some(n);
    }
    if is_ident(t) {
        if let Some(val_opt) = defines.get(t) {
            return match val_opt {
                Some(v) => eval_pp_int(v, defines).or(Some(1)),
                None => Some(1),
            };
        }
    }
    None
}

fn strip_inline_comment(s: &str) -> &str {
    let s = s.split("//").next().unwrap_or(s);
    s.split("/*").next().unwrap_or(s)
}

fn strip_outer_parens(mut s: &str) -> &str {
    loop {
        let t = s.trim();
        if t.starts_with('(') && t.ends_with(')') {
            let mut depth = 0i32;
            let mut wraps_all = true;
            for (idx, ch) in t.char_indices() {
                if ch == '(' {
                    depth += 1;
                } else if ch == ')' {
                    depth -= 1;
                    if depth == 0 && idx + 1 < t.len() {
                        wraps_all = false;
                        break;
                    }
                }
            }
            if wraps_all && depth == 0 {
                s = &t[1..t.len() - 1];
                continue;
            }
        }
        return t;
    }
}

fn split_top_level<'a>(s: &'a str, op: &str) -> Option<(&'a str, &'a str)> {
    let bytes = s.as_bytes();
    let op_bytes = op.as_bytes();
    let mut depth = 0i32;
    let mut i = 0;
    while i + op_bytes.len() <= bytes.len() {
        match bytes[i] {
            b'(' => depth += 1,
            b')' => depth = (depth - 1).max(0),
            _ if depth == 0 && &bytes[i..i + op_bytes.len()] == op_bytes => {
                return Some((s[..i].trim(), s[i + op_bytes.len()..].trim()));
            }
            _ => {}
        }
        i += 1;
    }
    None
}

fn is_ident(s: &str) -> bool {
    let mut chars = s.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Prune definitively inactive `#ifdef` / `#ifndef` / `#if` / `#elif` / `#else` lines while
/// **preserving exact 1-based line numbers** by replacing dead lines with empty lines.
///
/// Safety policy:
/// - `#if 0` is always pruned; `#if 1` always prunes its `#else` branch.
/// - If a macro `M` IS in `known_defines`, `#ifdef M` is active (its `#else` is pruned) and `#ifndef M` is pruned (its `#else` is active).
/// - If `strict_project_macros` is true (e.g. a real Keil/IAR/Makefile/CDB project provided defines)
///   and a macro matches known chip/driver prefixes (`STM32`, `USE_`, `CONFIG_`, `HAL_`, `ENABLE_`, `BSP_`, `MCU_`, `BOARD_`),
///   an absent macro is treated as undefined (`false`), pruning dead chip/driver branches!
pub fn prune_inactive_ifdefs(
    source: &str,
    known_defines: &HashMap<String, Option<String>>,
    strict_project_macros: bool,
) -> (String, usize) {
    let mut out_lines: Vec<String> = Vec::new();
    let mut stack: Vec<PpFrame> = Vec::new();
    let mut pruned_count = 0usize;

    let is_strict_macro = |ident: &str| -> bool {
        if !strict_project_macros {
            return false;
        }
        let up = ident.to_ascii_uppercase();
        up.starts_with("STM32")
            || up.starts_with("GD32")
            || up.starts_with("MH24")
            || up.starts_with("USE_")
            || up.starts_with("CONFIG_")
            || up.starts_with("ENABLE_")
            || up.starts_with("BOARD_")
            || up.starts_with("MCU_")
    };

    for raw_line in source.lines() {
        let trimmed = raw_line.trim();
        let parent_active = stack
            .last()
            .map(|f| f.parent_active && !matches!(f.current, BranchState::Inactive))
            .unwrap_or(true);

        if let Some(rest) = trimmed
            .strip_prefix("#ifdef")
            .filter(|r| r.is_empty() || r.starts_with(char::is_whitespace))
        {
            let ident = strip_inline_comment(rest).trim();
            let state = if !parent_active {
                BranchState::Inactive
            } else if known_defines.contains_key(ident) {
                BranchState::Active
            } else if is_strict_macro(ident) {
                BranchState::Inactive
            } else {
                BranchState::UnknownKeep
            };
            stack.push(PpFrame {
                parent_active,
                current: state,
                taken_any: matches!(state, BranchState::Active),
            });
            out_lines.push(raw_line.to_string());
            continue;
        }

        if let Some(rest) = trimmed
            .strip_prefix("#ifndef")
            .filter(|r| r.is_empty() || r.starts_with(char::is_whitespace))
        {
            let ident = strip_inline_comment(rest).trim();
            let state = if !parent_active {
                BranchState::Inactive
            } else if known_defines.contains_key(ident) {
                BranchState::Inactive
            } else if is_strict_macro(ident) {
                BranchState::Active
            } else {
                BranchState::UnknownKeep
            };
            stack.push(PpFrame {
                parent_active,
                current: state,
                taken_any: matches!(state, BranchState::Active),
            });
            out_lines.push(raw_line.to_string());
            continue;
        }

        if let Some(rest) = trimmed
            .strip_prefix("#if")
            .filter(|r| r.starts_with(char::is_whitespace) || r.starts_with('('))
        {
            let eval = if !parent_active {
                Some(false)
            } else {
                eval_pp_expr(rest, known_defines, false)
            };
            let state = match eval {
                Some(true) => BranchState::Active,
                Some(false) => BranchState::Inactive,
                None => BranchState::UnknownKeep,
            };
            stack.push(PpFrame {
                parent_active,
                current: state,
                taken_any: matches!(state, BranchState::Active),
            });
            out_lines.push(raw_line.to_string());
            continue;
        }

        if let Some(rest) = trimmed
            .strip_prefix("#elif")
            .filter(|r| r.starts_with(char::is_whitespace) || r.starts_with('('))
        {
            if let Some(top) = stack.last_mut() {
                if !top.parent_active || top.taken_any {
                    top.current = BranchState::Inactive;
                } else {
                    match eval_pp_expr(rest, known_defines, false) {
                        Some(true) => {
                            top.current = BranchState::Active;
                            top.taken_any = true;
                        }
                        Some(false) => {
                            top.current = BranchState::Inactive;
                        }
                        None => {
                            top.current = BranchState::UnknownKeep;
                        }
                    }
                }
            }
            out_lines.push(raw_line.to_string());
            continue;
        }

        if trimmed.starts_with("#else")
            && trimmed[5..].chars().next().map_or(true, |c| !c.is_ascii_alphanumeric() && c != '_')
        {
            if let Some(top) = stack.last_mut() {
                if !top.parent_active || top.taken_any {
                    top.current = BranchState::Inactive;
                } else if matches!(top.current, BranchState::Inactive) {
                    top.current = BranchState::Active;
                    top.taken_any = true;
                } else {
                    top.current = BranchState::UnknownKeep;
                }
            }
            out_lines.push(raw_line.to_string());
            continue;
        }

        if trimmed.starts_with("#endif") {
            stack.pop();
            out_lines.push(raw_line.to_string());
            continue;
        }

        let cur_active = stack
            .last()
            .map(|f| f.parent_active && !matches!(f.current, BranchState::Inactive))
            .unwrap_or(true);

        if cur_active {
            out_lines.push(raw_line.to_string());
        } else {
            pruned_count += 1;
            out_lines.push(String::new());
        }
    }

    (out_lines.join("\n"), pruned_count)
}

// ============================================================================
// 2. tree-sitter-c AST Parser
// ============================================================================

/// Extract global variable name -> type name map across a C/H file using tree-sitter-c.
pub fn extract_var_types_ast(source: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut parser = Parser::new();
    if parser.set_language(&tree_sitter_c::LANGUAGE.into()).is_err() {
        return map;
    }
    let Some(tree) = parser.parse(source, None) else {
        return map;
    };
    let bytes = source.as_bytes();
    collect_top_level_var_types(tree.root_node(), bytes, &mut map);
    map
}

fn collect_top_level_var_types(node: Node, src: &[u8], out: &mut HashMap<String, String>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "declaration" => {
                if let Some(base_t) = extract_decl_base_type(child, src) {
                    let mut dc = child.walk();
                    for sub in child.children(&mut dc) {
                        if matches!(
                            sub.kind(),
                            "init_declarator"
                                | "pointer_declarator"
                                | "array_declarator"
                                | "identifier"
                        ) {
                            // Skip function prototypes
                            if contains_node_kind(sub, "function_declarator")
                                && !contains_node_kind(sub, "abstract_pointer_declarator")
                            {
                                continue;
                            }
                            if let Some(name) = extract_declarator_ident(sub, src) {
                                out.entry(name).or_insert_with(|| base_t.clone());
                            }
                        }
                    }
                }
            }
            "preproc_if" | "preproc_ifdef" | "preproc_else" | "preproc_elif" => {
                collect_top_level_var_types(child, src, out);
            }
            _ => {}
        }
    }
}

/// Parse all C functions in `source` using `tree-sitter-c`.
/// `global_var_types` maps global variable names (and struct member names) to their C type names
/// so expressions like `huart->RxCpltCallback()` can be resolved to `SlotKey::StructField`.
pub fn parse_c_file_ast(
    rel_file: &str,
    source: &str,
    global_var_types: &HashMap<String, String>,
) -> Vec<AstFunction> {
    let mut parser = Parser::new();
    if parser.set_language(&tree_sitter_c::LANGUAGE.into()).is_err() {
        return Vec::new();
    }
    let Some(tree) = parser.parse(source, None) else {
        return Vec::new();
    };
    let src = source.as_bytes();
    let mut funcs = Vec::new();
    collect_functions(tree.root_node(), rel_file, src, global_var_types, &mut funcs);
    funcs
}

fn collect_functions(
    node: Node,
    rel_file: &str,
    src: &[u8],
    global_var_types: &HashMap<String, String>,
    out: &mut Vec<AstFunction>,
) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "function_definition" => {
                if let Some(af) = extract_function(child, rel_file, src, global_var_types) {
                    out.push(af);
                }
            }
            "preproc_if"
            | "preproc_ifdef"
            | "preproc_else"
            | "preproc_elif"
            | "linkage_specification" => {
                collect_functions(child, rel_file, src, global_var_types, out);
            }
            _ => {}
        }
    }
}

fn node_text<'a>(node: Node, src: &'a [u8]) -> &'a str {
    node.utf8_text(src).unwrap_or("")
}

fn contains_node_kind(node: Node, kind: &str) -> bool {
    if node.kind() == kind {
        return true;
    }
    let mut cursor = node.walk();
    for ch in node.children(&mut cursor) {
        if contains_node_kind(ch, kind) {
            return true;
        }
    }
    false
}

fn find_first_kind<'a>(node: Node<'a>, kind: &str) -> Option<Node<'a>> {
    if node.kind() == kind {
        return Some(node);
    }
    let mut cursor = node.walk();
    for ch in node.children(&mut cursor) {
        if let Some(found) = find_first_kind(ch, kind) {
            return Some(found);
        }
    }
    None
}

fn extract_decl_base_type(decl: Node, src: &[u8]) -> Option<String> {
    if let Some(ty) = decl.child_by_field_name("type") {
        let raw = node_text(ty, src).trim();
        let clean = raw
            .trim_start_matches("struct ")
            .trim_start_matches("enum ")
            .trim_start_matches("union ")
            .trim();
        if !clean.is_empty() {
            return Some(clean.to_string());
        }
    }
    None
}

fn extract_declarator_ident(node: Node, src: &[u8]) -> Option<String> {
    match node.kind() {
        "identifier" | "field_identifier" | "type_identifier" => {
            let t = node_text(node, src).trim();
            if !t.is_empty() {
                Some(t.to_string())
            } else {
                None
            }
        }
        "init_declarator" => node
            .child_by_field_name("declarator")
            .and_then(|d| extract_declarator_ident(d, src)),
        "pointer_declarator"
        | "array_declarator"
        | "parenthesized_declarator"
        | "attributed_declarator" => {
            if let Some(d) = node.child_by_field_name("declarator") {
                extract_declarator_ident(d, src)
            } else {
                let mut cursor = node.walk();
                for ch in node.children(&mut cursor) {
                    if let Some(id) = extract_declarator_ident(ch, src) {
                        return Some(id);
                    }
                }
                None
            }
        }
        "function_declarator" => node
            .child_by_field_name("declarator")
            .and_then(|d| extract_declarator_ident(d, src)),
        _ => None,
    }
}

fn extract_function(
    fn_node: Node,
    rel_file: &str,
    src: &[u8],
    global_var_types: &HashMap<String, String>,
) -> Option<AstFunction> {
    let decl_node = fn_node.child_by_field_name("declarator")?;
    let body_node = fn_node.child_by_field_name("body")?;

    // Find function_declarator inside pointer_declarator / etc.
    let fn_decl = find_first_kind(decl_node, "function_declarator")?;
    let name_node = fn_decl.child_by_field_name("declarator")?;
    let fn_name = extract_declarator_ident(name_node, src)?;
    if fn_name.is_empty() {
        return None;
    }

    let line_start = fn_node.start_position().row + 1;
    let line_end = fn_node.end_position().row + 1;
    let body_start_line = body_node.start_position().row + 1;
    let body_end_line = body_node.end_position().row + 1;

    let header_slice = &src[fn_node.start_byte()..body_node.start_byte().min(src.len())];
    let header_raw = std::str::from_utf8(header_slice).unwrap_or("");
    let signature = header_raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let is_weak = header_raw.contains("__WEAK")
        || header_raw.contains("__weak")
        || header_raw.contains("weak");
    let is_static = header_raw
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|t| t == "static");

    // Extract parameters
    let mut params = Vec::new();
    let mut local_var_types: HashMap<String, String> = HashMap::new();
    let mut param_name_to_idx: HashMap<String, usize> = HashMap::new();

    if let Some(plist) = fn_decl.child_by_field_name("parameters") {
        let mut pc = plist.walk();
        let mut p_idx = 0usize;
        for ch in plist.children(&mut pc) {
            if ch.kind() == "parameter_declaration" {
                let raw_p = node_text(ch, src).trim();
                if raw_p == "void" {
                    continue;
                }
                let type_name = extract_decl_base_type(ch, src);
                let p_decl = ch.child_by_field_name("declarator");
                let is_fn_ptr = p_decl
                    .map(|d| contains_node_kind(d, "function_declarator"))
                    .unwrap_or(false);
                let p_name = p_decl
                    .and_then(|d| extract_declarator_ident(d, src))
                    .unwrap_or_default();
                if !p_name.is_empty() {
                    param_name_to_idx.insert(p_name.clone(), p_idx);
                    if let Some(ref tn) = type_name {
                        local_var_types.insert(p_name.clone(), tn.clone());
                    }
                }
                params.push(AstParam {
                    index: p_idx,
                    name: p_name,
                    type_name,
                    is_fn_ptr,
                });
                p_idx += 1;
            }
        }
    }

    let mut ctx = BodyWalkCtx {
        src,
        param_name_to_idx,
        local_var_types,
        global_var_types,
        conditions: Vec::new(),
        local_decls: Vec::new(),
        seen_locals: HashSet::new(),
        has_switch: false,
        switch_cases: Vec::new(),
        direct_calls: Vec::new(),
        indirect_calls: Vec::new(),
        slot_writes: Vec::new(),
        slot_copies: Vec::new(),
        param_forwards: Vec::new(),
        config_assignments: Vec::new(),
    };

    ctx.walk(body_node);

    Some(AstFunction {
        name: fn_name,
        signature,
        file: rel_file.to_string(),
        line_start,
        line_end,
        body_start_line,
        body_end_line,
        is_weak,
        is_static,
        params,
        local_decls: ctx.local_decls,
        has_switch: ctx.has_switch,
        switch_cases: ctx.switch_cases,
        direct_calls: ctx.direct_calls,
        indirect_calls: ctx.indirect_calls,
        slot_writes: ctx.slot_writes,
        slot_copies: ctx.slot_copies,
        param_forwards: ctx.param_forwards,
        config_assignments: ctx.config_assignments,
    })
}

struct BodyWalkCtx<'a> {
    src: &'a [u8],
    param_name_to_idx: HashMap<String, usize>,
    local_var_types: HashMap<String, String>,
    global_var_types: &'a HashMap<String, String>,
    conditions: Vec<String>,
    local_decls: Vec<AstLocalDecl>,
    seen_locals: HashSet<String>,
    has_switch: bool,
    switch_cases: Vec<String>,
    direct_calls: Vec<AstDirectCall>,
    indirect_calls: Vec<AstIndirectCall>,
    slot_writes: Vec<AstSlotWrite>,
    slot_copies: Vec<AstSlotCopy>,
    param_forwards: Vec<AstParamForward>,
    config_assignments: Vec<String>,
}

impl<'a> BodyWalkCtx<'a> {
    fn resolve_var_type(&self, var: &str) -> Option<String> {
        self.local_var_types
            .get(var)
            .or_else(|| self.global_var_types.get(var))
            .cloned()
    }

    fn walk(&mut self, node: Node) {
        match node.kind() {
            "declaration" => {
                self.handle_declaration(node);
                // Still walk initializers in case they contain calls or assignments!
                let mut cursor = node.walk();
                for ch in node.children(&mut cursor) {
                    if ch.kind() == "init_declarator" {
                        if let Some(val) = ch.child_by_field_name("value") {
                            self.walk(val);
                        }
                    }
                }
                return;
            }
            "if_statement" => {
                let cond_text = node
                    .child_by_field_name("condition")
                    .map(|c| format!("if {}", compact_ws(node_text(c, self.src))))
                    .unwrap_or_else(|| "if (...)".to_string());
                if let Some(cond_node) = node.child_by_field_name("condition") {
                    self.walk(cond_node);
                }
                if let Some(cons) = node.child_by_field_name("consequence") {
                    self.conditions.push(cond_text.clone());
                    self.walk(cons);
                    self.conditions.pop();
                }
                if let Some(alt) = node.child_by_field_name("alternative") {
                    // `else_clause` wraps either another `if_statement` or a block
                    let is_else_if = alt
                        .named_child(0)
                        .map(|n| n.kind() == "if_statement")
                        .unwrap_or(false);
                    if is_else_if {
                        self.walk(alt);
                    } else {
                        self.conditions.push("else 分支".to_string());
                        self.walk(alt);
                        self.conditions.pop();
                    }
                }
                return;
            }
            "switch_statement" => {
                self.has_switch = true;
                let cond_text = node
                    .child_by_field_name("condition")
                    .map(|c| format!("switch {}", compact_ws(node_text(c, self.src))))
                    .unwrap_or_else(|| "switch (...)".to_string());
                if let Some(cond_node) = node.child_by_field_name("condition") {
                    self.walk(cond_node);
                }
                if let Some(body) = node.child_by_field_name("body") {
                    self.conditions.push(cond_text);
                    self.walk(body);
                    self.conditions.pop();
                }
                return;
            }
            "case_statement" => {
                let label = if let Some(val) = node.child_by_field_name("value") {
                    let v = compact_ws(node_text(val, self.src));
                    if !v.is_empty() && !self.switch_cases.contains(&v) && self.switch_cases.len() < 8 {
                        self.switch_cases.push(v.clone());
                    }
                    format!("case {}:", v)
                } else {
                    "default:".to_string()
                };
                self.conditions.push(label);
                let mut cursor = node.walk();
                for ch in node.children(&mut cursor) {
                    if Some(ch) != node.child_by_field_name("value") {
                        self.walk(ch);
                    }
                }
                self.conditions.pop();
                return;
            }
            "preproc_if" | "preproc_ifdef" => {
                let header = first_line(node_text(node, self.src));
                self.conditions.push(header);
                let mut cursor = node.walk();
                for ch in node.children(&mut cursor) {
                    if ch.kind() == "preproc_else" || ch.kind() == "preproc_elif" {
                        self.conditions.pop();
                        self.walk(ch);
                        return;
                    } else if ch.kind() != "preproc_directive"
                        && ch.kind() != "preproc_arg"
                        && ch.kind() != "#ifdef"
                        && ch.kind() != "#ifndef"
                        && ch.kind() != "#if"
                        && ch.kind() != "#endif"
                    {
                        self.walk(ch);
                    }
                }
                self.conditions.pop();
                return;
            }
            "preproc_else" | "preproc_elif" => {
                let header = first_line(node_text(node, self.src));
                self.conditions.push(header);
                let mut cursor = node.walk();
                for ch in node.children(&mut cursor) {
                    self.walk(ch);
                }
                self.conditions.pop();
                return;
            }
            "call_expression" => {
                self.handle_call(node);
            }
            "assignment_expression" => {
                self.handle_assignment(node);
            }
            _ => {}
        }

        let mut cursor = node.walk();
        for ch in node.children(&mut cursor) {
            self.walk(ch);
        }
    }

    fn handle_declaration(&mut self, decl: Node) {
        let raw_decl = node_text(decl, self.src);
        let is_static = raw_decl
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
            .any(|t| t == "static");
        let Some(base_t) = extract_decl_base_type(decl, self.src) else {
            return;
        };
        let raw_type_str = decl
            .child_by_field_name("type")
            .map(|t| compact_ws(node_text(t, self.src)))
            .unwrap_or_else(|| base_t.clone());

        let mut cursor = decl.walk();
        for ch in decl.children(&mut cursor) {
            let (declarator, init_val) = if ch.kind() == "init_declarator" {
                (
                    ch.child_by_field_name("declarator"),
                    ch.child_by_field_name("value"),
                )
            } else if matches!(
                ch.kind(),
                "pointer_declarator" | "array_declarator" | "identifier"
            ) {
                (Some(ch), None)
            } else {
                (None, None)
            };

            let Some(dnode) = declarator else { continue };
            let Some(var_name) = extract_declarator_ident(dnode, self.src) else {
                continue;
            };
            self.local_var_types.insert(var_name.clone(), base_t.clone());

            // Check if local variable is initialized with a function pointer or struct designated init!
            // e.g. `my_cb_t cb = on_done;` or `drv_cfg_t cfg = { .on_done = app_done };`
            if let Some(val) = init_val {
                self.handle_initializer_bindings(&var_name, &base_t, val);
            }

            if !self.seen_locals.insert(var_name.clone()) {
                continue;
            }
            let is_ptr = dnode.kind() == "pointer_declarator"
                || contains_node_kind(dnode, "pointer_declarator");
            let array_dim_raw = find_first_kind(dnode, "array_declarator")
                .and_then(|ad| ad.child_by_field_name("size"))
                .map(|sz| compact_ws(node_text(sz, self.src)));

            self.local_decls.push(AstLocalDecl {
                name: var_name,
                type_str: raw_type_str.clone(),
                base_type: base_t.clone(),
                is_ptr,
                is_static,
                array_dim_raw,
            });
        }
    }

    fn handle_initializer_bindings(&mut self, var_name: &str, base_type: &str, val: Node) {
        let line = val.start_position().row + 1;
        let expr = compact_ws(node_text(val, self.src));
        if val.kind() == "initializer_list" {
            let mut cursor = val.walk();
            for ch in val.children(&mut cursor) {
                if ch.kind() == "initializer_pair" {
                    let field_name = find_first_kind(ch, "field_identifier")
                        .map(|f| node_text(f, self.src).trim().to_string());
                    let rhs_node = ch.child_by_field_name("value");
                    if let (Some(fld), Some(rhs)) = (field_name, rhs_node) {
                        if let Some(rhs_id) = extract_expr_ident(rhs, self.src) {
                            let mut lhs_slots = vec![
                                SlotKey::VarField(var_name.to_string(), fld.clone()),
                                SlotKey::StructField(base_type.to_string(), fld.clone()),
                                SlotKey::FieldOnly(fld.clone()),
                            ];
                            lhs_slots.dedup();
                            let rhs_param_index = self.param_name_to_idx.get(&rhs_id).copied();
                            self.slot_writes.push(AstSlotWrite {
                                lhs_slots,
                                lhs_field: Some(fld),
                                rhs_ident: rhs_id,
                                rhs_param_index,
                                line,
                                expr: format!("{} = {}", var_name, expr),
                                conditions: self.conditions.clone(),
                            });
                        }
                    }
                }
            }
        } else if let Some(rhs_id) = extract_expr_ident(val, self.src) {
            let rhs_param_index = self.param_name_to_idx.get(&rhs_id).copied();
            self.slot_writes.push(AstSlotWrite {
                lhs_slots: vec![SlotKey::GlobalVar(var_name.to_string())],
                lhs_field: None,
                rhs_ident: rhs_id,
                rhs_param_index,
                line,
                expr: format!("{} = {}", var_name, expr),
                conditions: self.conditions.clone(),
            });
        }
    }

    fn handle_call(&mut self, call: Node) {
        let Some(func_node) = call.child_by_field_name("function") else {
            return;
        };
        let line = call.start_position().row + 1;
        let expr = first_line(node_text(call, self.src));

        // Extract arguments
        let mut args: Vec<AstCallArg> = Vec::new();
        let mut args_text = String::new();
        if let Some(arg_list) = call.child_by_field_name("arguments") {
            let raw_args = node_text(arg_list, self.src).trim();
            args_text = raw_args
                .strip_prefix('(')
                .and_then(|s| s.strip_suffix(')'))
                .unwrap_or(raw_args)
                .to_string();
            let mut ac = arg_list.walk();
            let mut idx = 0usize;
            for ch in arg_list.named_children(&mut ac) {
                let raw = compact_ws(node_text(ch, self.src));
                let ident = extract_expr_ident(ch, self.src);
                args.push(AstCallArg {
                    index: idx,
                    raw_text: raw,
                    ident,
                });
                idx += 1;
            }
        }

        // Unwrap `(*fp)(args)` or `(fp)(args)`
        let callee_expr = unwrap_callee_expr(func_node);

        match callee_expr.kind() {
            "identifier" => {
                let name = node_text(callee_expr, self.src).trim().to_string();
                if name.is_empty() {
                    return;
                }
                // Check if calling a function parameter directly: `cb(arg)`
                if let Some(&p_idx) = self.param_name_to_idx.get(&name) {
                    self.indirect_calls.push(AstIndirectCall {
                        receiver: name.clone(),
                        field: None,
                        callee_param_index: Some(p_idx),
                        slot_keys: vec![SlotKey::GlobalVar(name)],
                        line,
                        expr,
                        conditions: self.conditions.clone(),
                    });
                    return;
                }

                // Record parameter forwards: if any arg matches one of our own params!
                for a in &args {
                    if let Some(ref aid) = a.ident {
                        if let Some(&p_idx) = self.param_name_to_idx.get(aid) {
                            self.param_forwards.push(AstParamForward {
                                param_index: p_idx,
                                callee: name.clone(),
                                callee_arg_index: a.index,
                                line,
                                expr: expr.clone(),
                            });
                        }
                    }
                }

                // Record as direct call (and also indirect candidate in case `name` is a global fn ptr!)
                self.direct_calls.push(AstDirectCall {
                    callee: name.clone(),
                    line,
                    expr: expr.clone(),
                    args_text,
                    args,
                    conditions: self.conditions.clone(),
                });
                self.indirect_calls.push(AstIndirectCall {
                    receiver: name.clone(),
                    field: None,
                    callee_param_index: None,
                    slot_keys: vec![SlotKey::GlobalVar(name)],
                    line,
                    expr,
                    conditions: self.conditions.clone(),
                });
            }
            "field_expression" => {
                let (receiver, field, slots) = self.extract_field_slots(callee_expr);
                if let Some(fld) = field {
                    self.indirect_calls.push(AstIndirectCall {
                        receiver,
                        field: Some(fld),
                        callee_param_index: None,
                        slot_keys: slots,
                        line,
                        expr,
                        conditions: self.conditions.clone(),
                    });
                }
            }
            "subscript_expression" => {
                // e.g. `g_callbacks[id](arg)`
                if let Some(arr) = callee_expr.child_by_field_name("argument") {
                    let arr_name = extract_root_ident(arr, self.src);
                    if !arr_name.is_empty() {
                        let slots = vec![SlotKey::GlobalVar(arr_name.clone())];
                        self.indirect_calls.push(AstIndirectCall {
                            receiver: arr_name,
                            field: None,
                            callee_param_index: None,
                            slot_keys: slots,
                            line,
                            expr,
                            conditions: self.conditions.clone(),
                        });
                    }
                }
            }
            _ => {}
        }
    }

    fn handle_assignment(&mut self, assign: Node) {
        let Some(lhs) = assign.child_by_field_name("left") else {
            return;
        };
        let Some(rhs) = assign.child_by_field_name("right") else {
            return;
        };
        let line = assign.start_position().row + 1;
        let expr = compact_ws(node_text(assign, self.src));

        // Capture simple struct config assignments (e.g. `Init.Algorithm = CRYP_AES_GCM`)
        if lhs.kind() == "field_expression" && self.config_assignments.len() < 8 {
            let lhs_txt = compact_ws(node_text(lhs, self.src));
            let rhs_txt = compact_ws(node_text(rhs, self.src));
            if is_ident(&rhs_txt) {
                let short_lhs = lhs_txt
                    .rsplit(|c| c == '.' || c == '>')
                    .next()
                    .unwrap_or(&lhs_txt);
                let item = format!("{}={}", short_lhs, rhs_txt);
                if !self.config_assignments.contains(&item) {
                    self.config_assignments.push(item);
                }
            }
        }

        let (lhs_slots, lhs_field) = self.extract_lvalue_slots(lhs);
        if lhs_slots.is_empty() {
            return;
        }

        // Case A: RHS is a field/slot expression -> SlotCopy! e.g. `rx_msg[ep].cb = ep->ep_cb;`
        let rhs_unwrapped = unwrap_cast_and_parens(rhs);
        if matches!(
            rhs_unwrapped.kind(),
            "field_expression" | "subscript_expression"
        ) {
            let (src_slots, _) = self.extract_lvalue_slots(rhs_unwrapped);
            if !src_slots.is_empty() {
                self.slot_copies.push(AstSlotCopy {
                    dst_slots: lhs_slots.clone(),
                    src_slots,
                    line,
                    expr: expr.clone(),
                });
            }
        }

        // Case B: RHS is an identifier / `&fn` / `(cast)fn` -> SlotWrite (either direct fn or param!)
        if let Some(rhs_id) = extract_expr_ident(rhs, self.src) {
            let rhs_param_index = self.param_name_to_idx.get(&rhs_id).copied();
            // Also if RHS is a global/local var holding a fn ptr (not a param), record a slot copy
            if rhs_param_index.is_none() {
                self.slot_copies.push(AstSlotCopy {
                    dst_slots: lhs_slots.clone(),
                    src_slots: vec![SlotKey::GlobalVar(rhs_id.clone())],
                    line,
                    expr: expr.clone(),
                });
            }
            self.slot_writes.push(AstSlotWrite {
                lhs_slots,
                lhs_field,
                rhs_ident: rhs_id,
                rhs_param_index,
                line,
                expr,
                conditions: self.conditions.clone(),
            });
        }
    }

    fn extract_lvalue_slots(&self, node: Node) -> (Vec<SlotKey>, Option<String>) {
        let n = unwrap_cast_and_parens(node);
        match n.kind() {
            "identifier" => {
                let id = node_text(n, self.src).trim().to_string();
                if id.is_empty() {
                    (Vec::new(), None)
                } else {
                    (vec![SlotKey::GlobalVar(id)], None)
                }
            }
            "subscript_expression" => {
                // `g_callbacks[ep] = fn`
                if let Some(arr) = n.child_by_field_name("argument") {
                    let root = extract_root_ident(arr, self.src);
                    if !root.is_empty() {
                        return (vec![SlotKey::GlobalVar(root)], None);
                    }
                }
                (Vec::new(), None)
            }
            "field_expression" => {
                let (_, field, slots) = self.extract_field_slots(n);
                (slots, field)
            }
            _ => (Vec::new(), None),
        }
    }

    fn extract_field_slots(&self, field_expr: Node) -> (String, Option<String>, Vec<SlotKey>) {
        let Some(field_node) = field_expr.child_by_field_name("field") else {
            return (String::new(), None, Vec::new());
        };
        let field_name = node_text(field_node, self.src).trim().to_string();
        if field_name.is_empty() {
            return (String::new(), None, Vec::new());
        }

        let arg_node = field_expr.child_by_field_name("argument");
        let immediate_recv = arg_node
            .map(|a| extract_immediate_receiver(a, self.src))
            .unwrap_or_default();

        let mut slots = Vec::new();
        if !immediate_recv.is_empty() {
            if let Some(ty) = self.resolve_var_type(&immediate_recv) {
                slots.push(SlotKey::StructField(ty, field_name.clone()));
            }
            slots.push(SlotKey::VarField(immediate_recv.clone(), field_name.clone()));
        }
        slots.push(SlotKey::FieldOnly(field_name.clone()));
        slots.dedup();
        (immediate_recv, Some(field_name), slots)
    }
}

fn unwrap_callee_expr(mut node: Node) -> Node {
    loop {
        match node.kind() {
            "parenthesized_expression" => {
                if let Some(inner) = node.named_child(0) {
                    node = inner;
                    continue;
                }
            }
            "pointer_expression" => {
                // `(*fp)(args)`
                if let Some(arg) = node.child_by_field_name("argument") {
                    node = arg;
                    continue;
                }
            }
            "cast_expression" => {
                if let Some(val) = node.child_by_field_name("value") {
                    node = val;
                    continue;
                }
            }
            _ => {}
        }
        return node;
    }
}

fn unwrap_cast_and_parens(mut node: Node) -> Node {
    loop {
        match node.kind() {
            "parenthesized_expression" => {
                if let Some(inner) = node.named_child(0) {
                    node = inner;
                    continue;
                }
            }
            "cast_expression" => {
                if let Some(val) = node.child_by_field_name("value") {
                    node = val;
                    continue;
                }
            }
            _ => {}
        }
        return node;
    }
}

fn extract_expr_ident(mut node: Node, src: &[u8]) -> Option<String> {
    loop {
        match node.kind() {
            "identifier" => {
                let t = node_text(node, src).trim();
                return if is_ident(t) { Some(t.to_string()) } else { None };
            }
            "parenthesized_expression" => {
                node = node.named_child(0)?;
            }
            "cast_expression" => {
                node = node.child_by_field_name("value")?;
            }
            "pointer_expression" => {
                // `&my_callback`
                node = node.child_by_field_name("argument")?;
            }
            _ => return None,
        }
    }
}

fn extract_immediate_receiver(mut node: Node, src: &[u8]) -> String {
    loop {
        match node.kind() {
            "identifier" => return node_text(node, src).trim().to_string(),
            "field_expression" => {
                // For `phost->class_cb->Requests()`, immediate receiver of `Requests` is `class_cb`!
                if let Some(fld) = node.child_by_field_name("field") {
                    return node_text(fld, src).trim().to_string();
                }
                return String::new();
            }
            "subscript_expression" => {
                // For `rx_msg[ep].cb`, receiver is `rx_msg`!
                if let Some(arg) = node.child_by_field_name("argument") {
                    node = arg;
                    continue;
                }
                return String::new();
            }
            "parenthesized_expression" => {
                if let Some(inner) = node.named_child(0) {
                    node = inner;
                    continue;
                }
                return String::new();
            }
            "pointer_expression" => {
                if let Some(arg) = node.child_by_field_name("argument") {
                    node = arg;
                    continue;
                }
                return String::new();
            }
            _ => return String::new(),
        }
    }
}

fn extract_root_ident(mut node: Node, src: &[u8]) -> String {
    loop {
        match node.kind() {
            "identifier" => return node_text(node, src).trim().to_string(),
            "field_expression" => {
                if let Some(fld) = node.child_by_field_name("field") {
                    return node_text(fld, src).trim().to_string();
                }
                return String::new();
            }
            "subscript_expression" => {
                if let Some(arg) = node.child_by_field_name("argument") {
                    node = arg;
                    continue;
                }
                return String::new();
            }
            "parenthesized_expression" => {
                if let Some(inner) = node.named_child(0) {
                    node = inner;
                    continue;
                }
                return String::new();
            }
            _ => return String::new(),
        }
    }
}

fn compact_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or(s).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ifdef_pruning_preserves_line_numbers() {
        let code = r#"#ifdef USE_DMA
void dma_send(void) {}
#else
void poll_send(void) {}
#endif
#if 0
void dead_fn(void) {}
#endif
void always_alive(void) {}
"#;
        let mut defines = HashMap::new();
        defines.insert("USE_DMA".to_string(), None);

        let (pruned, count) = prune_inactive_ifdefs(code, &defines, true);
        assert!(count >= 2);
        assert_eq!(pruned.lines().count(), code.lines().count());

        let funcs = parse_c_file_ast("test.c", &pruned, &HashMap::new());
        let names: Vec<&str> = funcs.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"dma_send"));
        assert!(!names.contains(&"poll_send"));
        assert!(!names.contains(&"dead_fn"));
        assert!(names.contains(&"always_alive"));
        // Verify exact line number preservation for `always_alive` (line 9)
        let alive = funcs.iter().find(|f| f.name == "always_alive").unwrap();
        assert_eq!(alive.line_start, 9);
    }

    #[test]
    fn test_ast_extracts_param_forwards_and_slot_writes() {
        let code = r#"
typedef void (*rx_cb_t)(int len);
typedef struct { rx_cb_t rx_cb; } uart_ctx_t;
static uart_ctx_t g_uart;

void hal_bind(rx_cb_t cb) {
    g_uart.rx_cb = cb;
}

void drv_register(int ch, rx_cb_t cb) {
    hal_bind(cb);
}

void USART1_IRQHandler(void) {
    if (g_uart.rx_cb) {
        g_uart.rx_cb(64);
    }
}
"#;
        let var_types = extract_var_types_ast(code);
        let funcs = parse_c_file_ast("uart.c", code, &var_types);
        assert_eq!(funcs.len(), 3);

        let hal_bind = funcs.iter().find(|f| f.name == "hal_bind").unwrap();
        assert_eq!(hal_bind.slot_writes.len(), 1);
        assert_eq!(hal_bind.slot_writes[0].rhs_param_index, Some(0));
        assert!(hal_bind.slot_writes[0]
            .lhs_slots
            .contains(&SlotKey::VarField("g_uart".into(), "rx_cb".into())));

        let drv_reg = funcs.iter().find(|f| f.name == "drv_register").unwrap();
        assert_eq!(drv_reg.param_forwards.len(), 1);
        assert_eq!(drv_reg.param_forwards[0].param_index, 1);
        assert_eq!(drv_reg.param_forwards[0].callee, "hal_bind");
        assert_eq!(drv_reg.param_forwards[0].callee_arg_index, 0);

        let isr = funcs.iter().find(|f| f.name == "USART1_IRQHandler").unwrap();
        assert_eq!(isr.indirect_calls.len(), 1);
        assert!(isr.indirect_calls[0]
            .slot_keys
            .contains(&SlotKey::StructField("uart_ctx_t".into(), "rx_cb".into())));
    }
}
