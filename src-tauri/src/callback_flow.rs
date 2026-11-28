use crate::c_ast::{AstFunction, SlotKey};
use std::collections::{HashMap, HashSet};

/// Provenance of a callback binding discovered across 1..N hops.
#[derive(Debug, Clone)]
pub struct CallbackBinding {
    pub target_fn: String,
    pub origin_file: String,
    pub origin_line: usize,
    /// Ordered multi-hop registration path, e.g. `["app_init", "drv_register", "hal_bind", "g_uart.rx_cb"]`
    pub hop_chain: Vec<String>,
}

/// An asynchronous callback invocation edge resolved by the multi-hop solver.
#[derive(Debug, Clone)]
pub struct ResolvedAsyncEdge {
    pub source_fn: String,
    pub target_fn: String,
    pub label: String,
    pub registered_at: String,
    pub call_site_line: usize,
    pub call_site_expr: String,
    pub conditions: Vec<String>,
    pub hop_count: usize,
}

/// Fixed-point multi-hop async callback solver.
///
/// Tracks:
///   1. Direct argument registration: `app_init` -> `drv_reg(on_rx)`
///   2. Multi-hop parameter forwarding: `drv_reg(cb)` -> `hal_reg(0, cb)` -> `ll_bind(cb)`
///   3. Parameter-to-slot storage: `ll_bind(cb)` writes `g_ctx.rx_cb = cb` / `g_cb = cb` / `ep[n].cb = cb`
///   4. Direct slot storage: `app_init` writes `g_cb = on_rx` / `cfg.on_done = on_rx`
///   5. Slot-to-slot copying (config-struct forwarding): `rx_msg[ep].cb = ep->ep_cb`
///   6. Chained/nested async callbacks: `on_stage1_done` registers `on_stage2_done` -> resolved in the same fixed-point!
///   7. Trigger stitching (`INVOKE_CB`): resolves both direct param calls `cb()` and indirect slot calls
///      `g_ctx.rx_cb()` / `g_cb()` / `huart->RxCpltCallback()` / `rx_msg[ep].cb()`.
pub fn solve_multi_hop_callbacks(
    ast_funcs: &HashMap<String, AstFunction>,
    known_func_names: &HashSet<String>,
) -> Vec<ResolvedAsyncEdge> {
    // (func_name, param_index) -> list of concrete callback functions flowing into that parameter
    let mut param_values: HashMap<(String, usize), Vec<CallbackBinding>> = HashMap::new();
    // SlotKey -> list of concrete callback functions stored in that slot
    let mut slot_values: HashMap<SlotKey, Vec<CallbackBinding>> = HashMap::new();

    let push_param = |map: &mut HashMap<(String, usize), Vec<CallbackBinding>>,
                      key: (String, usize),
                      binding: CallbackBinding|
     -> bool {
        let list = map.entry(key).or_default();
        if list.len() >= 12 || list.iter().any(|b| b.target_fn == binding.target_fn) {
            return false;
        }
        list.push(binding);
        true
    };

    let push_slot = |map: &mut HashMap<SlotKey, Vec<CallbackBinding>>,
                     key: SlotKey,
                     binding: CallbackBinding|
     -> bool {
        let list = map.entry(key).or_default();
        if list.len() >= 12 || list.iter().any(|b| b.target_fn == binding.target_fn) {
            return false;
        }
        list.push(binding);
        true
    };

    // ------------------------------------------------------------------------
    // Seed Pass: Hop-0 direct registrations & direct slot assignments
    // ------------------------------------------------------------------------
    for (fn_name, af) in ast_funcs {
        // Seed 1: Direct call passing a known function symbol as an argument
        for call in &af.direct_calls {
            for arg in &call.args {
                if let Some(ref ident) = arg.ident {
                    if ident != &call.callee && known_func_names.contains(ident) {
                        let binding = CallbackBinding {
                            target_fn: ident.clone(),
                            origin_file: af.file.clone(),
                            origin_line: call.line,
                            hop_chain: vec![fn_name.clone(), call.callee.clone()],
                        };
                        push_param(&mut param_values, (call.callee.clone(), arg.index), binding);
                    }
                }
            }
        }

        // Seed 2: Direct assignment `slot = known_fn`
        for sw in &af.slot_writes {
            if sw.rhs_param_index.is_none() && known_func_names.contains(&sw.rhs_ident) {
                for slot in &sw.lhs_slots {
                    let binding = CallbackBinding {
                        target_fn: sw.rhs_ident.clone(),
                        origin_file: af.file.clone(),
                        origin_line: sw.line,
                        hop_chain: vec![fn_name.clone(), slot.display_label()],
                    };
                    push_slot(&mut slot_values, slot.clone(), binding);
                }
            }
        }
    }

    // ------------------------------------------------------------------------
    // Fixed-Point Propagation Pass (up to 10 hops)
    // ------------------------------------------------------------------------
    for _iter in 0..10 {
        let mut changed = false;

        // Rule A: Multi-hop parameter forwarding `A(p_i) -> B(arg_k)`
        let mut new_params: Vec<((String, usize), CallbackBinding)> = Vec::new();
        for (fn_name, af) in ast_funcs {
            for pf in &af.param_forwards {
                if let Some(incoming) = param_values.get(&(fn_name.clone(), pf.param_index)) {
                    for b in incoming {
                        if b.hop_chain.len() >= 8 || b.hop_chain.contains(&pf.callee) {
                            continue;
                        }
                        let mut next_chain = b.hop_chain.clone();
                        next_chain.push(pf.callee.clone());
                        new_params.push((
                            (pf.callee.clone(), pf.callee_arg_index),
                            CallbackBinding {
                                target_fn: b.target_fn.clone(),
                                origin_file: b.origin_file.clone(),
                                origin_line: b.origin_line,
                                hop_chain: next_chain,
                            },
                        ));
                    }
                }
            }
        }
        for (k, b) in new_params {
            if push_param(&mut param_values, k, b) {
                changed = true;
            }
        }

        // Rule B: Parameter-to-slot storage `B(p_i) -> slot = p_i`
        let mut new_slots: Vec<(SlotKey, CallbackBinding)> = Vec::new();
        for (fn_name, af) in ast_funcs {
            for sw in &af.slot_writes {
                if let Some(p_idx) = sw.rhs_param_index {
                    if let Some(incoming) = param_values.get(&(fn_name.clone(), p_idx)) {
                        for b in incoming {
                            if b.hop_chain.len() >= 8 {
                                continue;
                            }
                            for slot in &sw.lhs_slots {
                                let mut next_chain = b.hop_chain.clone();
                                let sl = slot.display_label();
                                if next_chain.last().map(String::as_str) != Some(sl.as_str()) {
                                    next_chain.push(sl);
                                }
                                new_slots.push((
                                    slot.clone(),
                                    CallbackBinding {
                                        target_fn: b.target_fn.clone(),
                                        origin_file: b.origin_file.clone(),
                                        origin_line: b.origin_line,
                                        hop_chain: next_chain,
                                    },
                                ));
                            }
                        }
                    }
                }
            }
        }

        // Rule C: Slot-to-slot copying (e.g. config struct `rx_msg[ep].cb = ep->ep_cb` or `g_cb = cfg->cb`)
        for (fn_name, af) in ast_funcs {
            for sc in &af.slot_copies {
                // Find the most specific source slot that has bindings
                let mut matched_bindings: Option<Vec<CallbackBinding>> = None;
                for src_slot in &sc.src_slots {
                    if let Some(bs) = slot_values.get(src_slot) {
                        if !bs.is_empty() {
                            matched_bindings = Some(bs.clone());
                            break;
                        }
                    }
                }
                if let Some(bs) = matched_bindings {
                    for b in bs {
                        if b.hop_chain.len() >= 8 {
                            continue;
                        }
                        for dst_slot in &sc.dst_slots {
                            let mut next_chain = b.hop_chain.clone();
                            if !next_chain.contains(fn_name) {
                                next_chain.push(fn_name.clone());
                            }
                            let dl = dst_slot.display_label();
                            if next_chain.last().map(String::as_str) != Some(dl.as_str()) {
                                next_chain.push(dl);
                            }
                            new_slots.push((
                                dst_slot.clone(),
                                CallbackBinding {
                                    target_fn: b.target_fn.clone(),
                                    origin_file: b.origin_file.clone(),
                                    origin_line: b.origin_line,
                                    hop_chain: next_chain,
                                },
                            ));
                        }
                    }
                }
            }
        }

        for (slot, b) in new_slots {
            if push_slot(&mut slot_values, slot, b) {
                changed = true;
            }
        }

        if !changed {
            break;
        }
    }

    // ------------------------------------------------------------------------
    // Trigger Stitching Pass: Resolve every indirect / callback call site
    // ------------------------------------------------------------------------
    let mut resolved = Vec::new();
    let mut seen_edges: HashSet<(String, String)> = HashSet::new();

    for (caller_name, af) in ast_funcs {
        for ic in &af.indirect_calls {
            // Skip if `ic.receiver` is actually a normal defined function name (direct call, not fp!)
            if ic.field.is_none()
                && ic.callee_param_index.is_none()
                && known_func_names.contains(&ic.receiver)
            {
                continue;
            }

            let mut bindings: Vec<CallbackBinding> = Vec::new();

            // 1. Direct parameter invocation: `cb(arg)`
            if let Some(p_idx) = ic.callee_param_index {
                if let Some(bs) = param_values.get(&(caller_name.clone(), p_idx)) {
                    bindings.extend(bs.iter().cloned());
                }
            }

            // 2. Slot lookup in specificity order: StructField / VarField / GlobalVar first,
            //    FieldOnly only as fallback if no specific slot matched!
            if bindings.is_empty() {
                for slot in &ic.slot_keys {
                    if let Some(bs) = slot_values.get(slot) {
                        if !bs.is_empty() {
                            // Guard FieldOnly fallback: avoid noisy generic field names if too many targets
                            if matches!(slot, SlotKey::FieldOnly(_)) && bs.len() > 4 {
                                continue;
                            }
                            bindings.extend(bs.iter().cloned());
                            break;
                        }
                    }
                }
            }

            for b in bindings {
                if caller_name == &b.target_fn || !known_func_names.contains(&b.target_fn) {
                    continue;
                }
                if !seen_edges.insert((caller_name.clone(), b.target_fn.clone())) {
                    continue;
                }
                let call_label = match &ic.field {
                    Some(fld) => format!("{}->{}()", ic.receiver, fld),
                    None => format!("{}()", ic.receiver),
                };
                let hop_count = b.hop_chain.len();
                let reg_trace = format!(
                    "{}:{} (经 {})",
                    b.origin_file,
                    b.origin_line,
                    b.hop_chain.join(" -> ")
                );
                resolved.push(ResolvedAsyncEdge {
                    source_fn: caller_name.clone(),
                    target_fn: b.target_fn,
                    label: call_label,
                    registered_at: reg_trace,
                    call_site_line: ic.line,
                    call_site_expr: ic.expr.clone(),
                    conditions: ic.conditions.clone(),
                    hop_count,
                });
            }
        }
    }

    resolved
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::c_ast::{extract_var_types_ast, parse_c_file_ast};

    #[test]
    fn test_multi_hop_and_nested_async_callback_chain() {
        // Real-world embedded 3-hop registration + nested Stage-1 -> Stage-2 async callback chain + config-struct copy!
        let code = r#"
typedef void (*evt_cb_t)(int status);
typedef struct {
    evt_cb_t on_rx;
    evt_cb_t on_tx;
} uart_drv_t;

typedef struct {
    evt_cb_t ep_cb;
} ep_cfg_t;

static uart_drv_t g_uart;
static evt_cb_t g_ep_slot[4];

void hal_uart_set_rx_slot(evt_cb_t fn_ptr) {
    g_uart.on_rx = fn_ptr;
}

void hal_uart_set_tx_slot(evt_cb_t fn_ptr) {
    g_uart.on_tx = fn_ptr;
}

/* Wrapper layer 2 */
void drv_uart_register_rx(int port, evt_cb_t cb) {
    hal_uart_set_rx_slot(cb);
}

/* Config-struct slot copy registration (CherryUSB style) */
void usbd_add_ep(ep_cfg_t *cfg) {
    g_ep_slot[0] = cfg->ep_cb;
}

/* Stage-2 async callback (registered INSIDE Stage-1 callback!) */
void app_on_tx_done(int status) {
    (void)status;
}

/* Stage-1 async callback: handles RX, then registers Stage-2 TX callback */
void app_on_rx_done(int status) {
    if (status == 0) {
        hal_uart_set_tx_slot(app_on_tx_done);
    }
}

void app_ep_callback(int status) {
    (void)status;
}

void app_init(void) {
    ep_cfg_t ep = { .ep_cb = app_ep_callback };
    drv_uart_register_rx(1, app_on_rx_done);
    usbd_add_ep(&ep);
}

void USART1_IRQHandler(void) {
    if (g_uart.on_rx) {
        g_uart.on_rx(0);
    }
    if (g_uart.on_tx) {
        g_uart.on_tx(1);
    }
}

void USB_IRQHandler(void) {
    g_ep_slot[0](0);
}
"#;
        let var_types = extract_var_types_ast(code);
        let funcs = parse_c_file_ast("app.c", code, &var_types);
        let mut ast_map: HashMap<String, AstFunction> = HashMap::new();
        let mut known_names: HashSet<String> = HashSet::new();
        for f in funcs {
            known_names.insert(f.name.clone());
            ast_map.insert(f.name.clone(), f);
        }

        let edges = solve_multi_hop_callbacks(&ast_map, &known_names);

        // 1. 3-hop registration: app_init -> drv_uart_register_rx -> hal_uart_set_rx_slot -> g_uart.on_rx -> USART1_IRQHandler
        let rx_edge = edges
            .iter()
            .find(|e| e.source_fn == "USART1_IRQHandler" && e.target_fn == "app_on_rx_done")
            .expect("3-hop RX callback edge must be resolved");
        assert!(rx_edge.registered_at.contains("app_init -> drv_uart_register_rx -> hal_uart_set_rx_slot"));

        // 2. Nested Stage-2 async callback registered inside Stage-1 callback `app_on_rx_done`!
        let tx_edge = edges
            .iter()
            .find(|e| e.source_fn == "USART1_IRQHandler" && e.target_fn == "app_on_tx_done")
            .expect("nested Stage-2 TX callback edge must be resolved");
        assert!(tx_edge.registered_at.contains("app_on_rx_done -> hal_uart_set_tx_slot"));

        // 3. Config-struct slot-to-slot copy (CherryUSB style): ep.ep_cb -> g_ep_slot[0] -> USB_IRQHandler
        let ep_edge = edges
            .iter()
            .find(|e| e.source_fn == "USB_IRQHandler" && e.target_fn == "app_ep_callback")
            .expect("config-struct slot-to-slot copy callback edge must be resolved");
        assert!(ep_edge.registered_at.contains("usbd_add_ep"));
    }
}
