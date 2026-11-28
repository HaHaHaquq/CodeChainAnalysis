use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ProjectSourceKind {
    CompileCommands,
    KeilUvprojx,
    IarEwp,
    Makefile,
    DirectoryFallback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CompilerFlavor {
    Armcc,
    Armclang,
    IarArm,
    IarRl78,
    Gcc,
    Clang,
    Unknown,
}

impl CompilerFlavor {
    pub fn as_str(&self) -> &'static str {
        match self {
            CompilerFlavor::Armcc => "ARMCC (Keil AC5)",
            CompilerFlavor::Armclang => "ARMCLANG (Keil AC6)",
            CompilerFlavor::IarArm => "IAR EWARM",
            CompilerFlavor::IarRl78 => "IAR RL78",
            CompilerFlavor::Gcc => "GCC / ARM-GCC",
            CompilerFlavor::Clang => "Clang",
            CompilerFlavor::Unknown => "Unknown",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildTarget {
    pub name: String,
    pub project_file: Option<PathBuf>,
    pub compiler_flavor: CompilerFlavor,
    pub sources: Vec<PathBuf>,
    pub include_dirs: Vec<PathBuf>,
    /// Key -> optional value (e.g. ("USE_HAL_DRIVER", None), ("HSE_VALUE", Some("8000000")))
    pub defines: Vec<(String, Option<String>)>,
    pub excluded_files: Vec<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectModel {
    pub root_dir: PathBuf,
    pub source_kind: ProjectSourceKind,
    pub targets: Vec<BuildTarget>,
    pub active_target_index: usize,
}

impl ProjectModel {
    pub fn active_target(&self) -> Option<&BuildTarget> {
        self.targets.get(self.active_target_index).or_else(|| self.targets.first())
    }

    /// Build a standard `compile_commands.json` JSON array in memory for the chosen target.
    /// Does not modify the user's workspace; used by Stage 3 (clangd) or optional export.
    pub fn build_compile_commands(&self, target_idx: Option<usize>) -> Value {
        let Some(target) = target_idx
            .and_then(|i| self.targets.get(i))
            .or_else(|| self.active_target())
        else {
            return json!([]);
        };

        let dir_str = normalize_slash(&self.root_dir);
        let compiler = match target.compiler_flavor {
            CompilerFlavor::Clang | CompilerFlavor::Armclang => "clang",
            CompilerFlavor::IarRl78 => "rl78-elf-gcc",
            _ => "arm-none-eabi-gcc",
        };

        let mut extra_shims: Vec<String> = Vec::new();
        match target.compiler_flavor {
            CompilerFlavor::Armcc => {
                extra_shims.extend([
                    "-D__CC_ARM=1".into(),
                    "-D__ARMCC_VERSION=5060960".into(),
                    "-D__GNUC__=4".into(),
                    "-D__weak=__attribute__((weak))".into(),
                    "-D__packed=__attribute__((packed))".into(),
                    "-D__irq=".into(),
                    "-D__align(x)=__attribute__((aligned(x)))".into(),
                    "-D__forceinline=inline".into(),
                ]);
            }
            CompilerFlavor::Armclang => {
                extra_shims.extend([
                    "-D__ARMCC_VERSION=6190000".into(),
                    "-D__GNUC__=4".into(),
                    "-D__weak=__attribute__((weak))".into(),
                    "-D__packed=__attribute__((packed))".into(),
                ]);
            }
            CompilerFlavor::IarArm => {
                extra_shims.extend([
                    "-D__ICCARM__=1".into(),
                    "-D__GNUC__=4".into(),
                    "-D__weak=__attribute__((weak))".into(),
                    "-D__packed=__attribute__((packed))".into(),
                    "-D__no_init=".into(),
                    "-D__root=".into(),
                ]);
            }
            CompilerFlavor::IarRl78 => {
                extra_shims.extend([
                    "-D__ICCRL78__=1".into(),
                    "-D__GNUC__=4".into(),
                    "-D__near=".into(),
                    "-D__far=".into(),
                    "-D__saddr=".into(),
                    "-D__sfr=".into(),
                    "-D__callt=".into(),
                    "-D__interrupt=".into(),
                    "-D__root=".into(),
                    "-D__no_init=".into(),
                ]);
            }
            CompilerFlavor::Gcc | CompilerFlavor::Clang | CompilerFlavor::Unknown => {}
        }

        let mut entries = Vec::new();
        let sys_includes = discover_host_system_includes(target.compiler_flavor);
        for src in &target.sources {
            let ext = src
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !matches!(ext.as_str(), "c" | "cc" | "cpp" | "cxx") {
                continue;
            }
            let file_str = normalize_slash(src);
            let mut args: Vec<String> = Vec::new();
            args.push(compiler.to_string());
            args.push("-c".to_string());
            args.push(file_str.clone());
            args.extend(extra_shims.iter().cloned());
            for inc in &target.include_dirs {
                args.push(format!("-I{}", normalize_slash(inc)));
            }
            for sys_inc in &sys_includes {
                args.push("-isystem".to_string());
                args.push(normalize_slash(sys_inc));
            }
            for (k, v) in &target.defines {
                if let Some(val) = v {
                    args.push(format!("-D{}={}", k, val));
                } else {
                    args.push(format!("-D{}", k));
                }
            }
            let cmd = args
                .iter()
                .map(|a| {
                    if a.contains(' ') {
                        format!("\"{}\"", a)
                    } else {
                        a.clone()
                    }
                })
                .collect::<Vec<_>>()
                .join(" ");

            entries.push(json!({
                "directory": dir_str,
                "file": file_str,
                "arguments": args,
                "command": cmd,
            }));
        }

        Value::Array(entries)
    }

    /// Write `compile_commands.json` into an isolated temp directory (never dirties the user repo).
    pub fn write_temp_compile_commands(&self, target_idx: Option<usize>) -> Result<PathBuf, String> {
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in self.root_dir.to_string_lossy().as_bytes() {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        let out_dir = std::env::temp_dir()
            .join("chain_analysis_cdb")
            .join(format!("{:016x}", hash));
        fs::create_dir_all(&out_dir).map_err(|e| format!("创建临时编译数据库目录失败: {}", e))?;
        let cdb_path = out_dir.join("compile_commands.json");
        let val = self.build_compile_commands(target_idx);
        let text =
            serde_json::to_string_pretty(&val).map_err(|e| format!("序列化编译数据库失败: {}", e))?;
        fs::write(&cdb_path, text).map_err(|e| format!("写入 compile_commands.json 失败: {}", e))?;
        Ok(out_dir)
    }
}

/// Auto-detect and parse the best project model under `root_path`:
/// Priority:
///   1. Existing `compile_commands.json` (root or common build dirs)
///   2. Keil MDK (`.uvprojx` / `.uvproj`)
///   3. IAR EWARM / RL78 (`.eww` / `.ewp`)
///   4. Static GCC `Makefile` / `makefile`
///   5. DirectoryFallback (no IDE/build metadata found)
pub fn discover_project_model(root_path: &Path) -> ProjectModel {
    let root_canon = fs::canonicalize(root_path).unwrap_or_else(|_| root_path.to_path_buf());

    // 1. Existing compile_commands.json (CMake, Zephyr, ESP-IDF, Bear, Keil2Json, etc.)
    if let Some(cdb_path) = find_compile_commands_json(&root_canon) {
        if let Some(model) = parse_compile_commands_json(&root_canon, &cdb_path) {
            return model;
        }
    }

    // 2. Keil .uvprojx / .uvproj
    if let Some(keil_file) = find_keil_project_file(&root_canon) {
        if let Some(model) = parse_keil_uvproj(&root_canon, &keil_file) {
            return model;
        }
    }

    // 3. IAR .eww / .ewp
    if let Some(model) = discover_and_parse_iar(&root_canon) {
        return model;
    }

    // 4. Static GCC Makefile
    if let Some(makefile_path) = find_makefile(&root_canon) {
        if let Some(model) = parse_makefile_static(&root_canon, &makefile_path) {
            return model;
        }
    }

    // 5. Fallback
    ProjectModel {
        root_dir: root_canon,
        source_kind: ProjectSourceKind::DirectoryFallback,
        targets: Vec::new(),
        active_target_index: 0,
    }
}

/// Optional host-toolchain system header & CMSIS include discovery.
/// ONLY used when generating temporary `compile_commands.json` for Stage 3 `clangd` LSP;
/// never pollutes Stage 1/2 user file scans or porting checklists.
pub fn discover_host_system_includes(flavor: CompilerFlavor) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();

    match flavor {
        CompilerFlavor::Armcc | CompilerFlavor::Armclang => {
            let mut keil_roots: Vec<PathBuf> = Vec::new();
            if let Ok(env_k) = std::env::var("KEIL_PATH") {
                keil_roots.push(PathBuf::from(env_k));
            }
            for cand in [
                r"C:\Keil_v5",
                r"D:\Keil_v5",
                r"E:\Keil_v5",
                r"C:\Keil",
                r"D:\Keil",
            ] {
                let p = PathBuf::from(cand);
                if p.is_dir() {
                    keil_roots.push(p);
                }
            }

            for root in keil_roots {
                let tools_ini = root.join("TOOLS.INI");
                if let Some(ini_txt) = read_text_auto(&tools_ini) {
                    let mut section = String::new();
                    for raw_line in ini_txt.lines() {
                        let line = raw_line.trim();
                        if line.starts_with('[') && line.ends_with(']') {
                            section = line[1..line.len() - 1].to_ascii_uppercase();
                            continue;
                        }
                        if let Some((k, v)) = line.split_once('=') {
                            let key = k.trim().to_ascii_uppercase();
                            let val = v.trim().trim_matches('"');
                            if key == "RTEPATH" {
                                collect_cmsis_includes(Path::new(val), &mut found, &mut seen);
                            } else if key == "PATH" {
                                let p = PathBuf::from(val);
                                if section == "ARMCLANG" && flavor == CompilerFlavor::Armclang {
                                    let inc = p.join("include");
                                    if inc.is_dir() {
                                        push_unique_path(&mut found, &mut seen, inc);
                                    }
                                } else if section == "ARMCC" && flavor == CompilerFlavor::Armcc {
                                    let inc = p.join("include");
                                    if inc.is_dir() {
                                        push_unique_path(&mut found, &mut seen, inc);
                                    }
                                } else if section == "ARM" {
                                    let sub = if flavor == CompilerFlavor::Armclang {
                                        p.join("ARMCLANG").join("include")
                                    } else {
                                        p.join("ARMCC").join("include")
                                    };
                                    if sub.is_dir() {
                                        push_unique_path(&mut found, &mut seen, sub);
                                    }
                                }
                            }
                        }
                    }
                }

                let sub_inc = if flavor == CompilerFlavor::Armclang {
                    root.join("ARM").join("ARMCLANG").join("include")
                } else {
                    root.join("ARM").join("ARMCC").join("include")
                };
                if sub_inc.is_dir() {
                    push_unique_path(&mut found, &mut seen, sub_inc);
                }
                collect_cmsis_includes(&root.join("ARM").join("Packs"), &mut found, &mut seen);
                collect_cmsis_includes(&root.join("ARM").join("PACK"), &mut found, &mut seen);
                collect_cmsis_includes(&root.join("ARM").join("CMSIS"), &mut found, &mut seen);
            }
        }
        CompilerFlavor::IarArm | CompilerFlavor::IarRl78 => {
            let arch = if flavor == CompilerFlavor::IarRl78 {
                "rl78"
            } else {
                "arm"
            };
            for base in [
                r"C:\Program Files\IAR Systems",
                r"C:\Program Files (x86)\IAR Systems",
                r"D:\IAR Systems",
            ] {
                let bp = Path::new(base);
                if let Ok(rd) = fs::read_dir(bp) {
                    for entry in rd.flatten() {
                        let sub = entry.path().join(arch);
                        if sub.is_dir() {
                            let c_inc = sub.join("inc").join("c");
                            if c_inc.is_dir() {
                                push_unique_path(&mut found, &mut seen, c_inc);
                            }
                            if flavor == CompilerFlavor::IarRl78 {
                                let inc = sub.join("inc");
                                if inc.is_dir() {
                                    push_unique_path(&mut found, &mut seen, inc);
                                }
                            } else {
                                collect_cmsis_includes(&sub.join("CMSIS"), &mut found, &mut seen);
                            }
                        }
                    }
                }
            }
        }
        CompilerFlavor::Gcc | CompilerFlavor::Clang | CompilerFlavor::Unknown => {
            if let Ok(path_env) = std::env::var("PATH") {
                for dir in std::env::split_paths(&path_env) {
                    let gcc = dir.join(if cfg!(windows) {
                        "arm-none-eabi-gcc.exe"
                    } else {
                        "arm-none-eabi-gcc"
                    });
                    if gcc.is_file() {
                        if let Some(parent) = dir.parent() {
                            let sys_inc = parent.join("arm-none-eabi").join("include");
                            if sys_inc.is_dir() {
                                push_unique_path(&mut found, &mut seen, sys_inc);
                            }
                        }
                        break;
                    }
                }
            }
        }
    }

    found
}

fn collect_cmsis_includes(base: &Path, found: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>) {
    let candidates = [
        base.join("Core").join("Include"),
        base.join("Include"),
        base.join("ARM").join("CMSIS"),
        base.to_path_buf(),
    ];
    for c in &candidates {
        if c.join("cmsis_compiler.h").is_file() || c.join("core_cm4.h").is_file() {
            push_unique_path(found, seen, c.clone());
            return;
        }
    }
    let cmsis_root = if base.join("ARM").join("CMSIS").is_dir() {
        base.join("ARM").join("CMSIS")
    } else {
        base.to_path_buf()
    };
    if let Ok(rd) = fs::read_dir(&cmsis_root) {
        let mut vers: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        vers.sort();
        for ver_dir in vers.into_iter().rev() {
            for rel in ["CMSIS/Core/Include", "Core/Include", "CMSIS/Include", "Include"] {
                let inc = ver_dir.join(rel);
                if inc.is_dir() {
                    push_unique_path(found, seen, inc);
                    return;
                }
            }
        }
    }
}

fn is_ignored_dir_name(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    matches!(
        low.as_str(),
        ".git"
            | ".svn"
            | ".hg"
            | ".vscode"
            | ".idea"
            | "node_modules"
            | "target"
            | "dist"
            | "obj"
            | "objects"
            | "listings"
            | "rte"
            | "debugconfig"
    )
}

fn read_text_auto(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(bytes[3..].to_vec()).ok();
    }
    if let Ok(utf8) = String::from_utf8(bytes.clone()) {
        return Some(utf8);
    }
    let (decoded, _, _) = encoding_rs::GB18030.decode(&bytes);
    Some(decoded.into_owned())
}

fn normalize_slash(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    // Strip Windows extended-length path prefix `//?/` from fs::canonicalize
    if let Some(stripped) = s.strip_prefix("//?/") {
        stripped.to_string()
    } else {
        s
    }
}

fn resolve_path(base_dir: &Path, raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim().trim_matches('"').trim_matches('\'');
    if trimmed.is_empty() {
        return None;
    }
    let normalized = trimmed.replace('\\', "/");
    let candidate = if Path::new(&normalized).is_absolute() {
        PathBuf::from(&normalized)
    } else {
        base_dir.join(&normalized)
    };
    if let Ok(canon) = fs::canonicalize(&candidate) {
        Some(canon)
    } else if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

fn parse_define_token(raw: &str) -> Option<(String, Option<String>)> {
    let t = raw.trim().trim_matches('"').trim_matches('\'');
    if t.is_empty() {
        return None;
    }
    let t = t.strip_prefix("-D").unwrap_or(t).trim();
    if t.is_empty() {
        return None;
    }
    if let Some((k, v)) = t.split_once('=') {
        let key = k.trim();
        if key.is_empty() {
            return None;
        }
        Some((key.to_string(), Some(v.trim().to_string())))
    } else {
        Some((t.to_string(), None))
    }
}

fn push_unique_path(list: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, p: PathBuf) {
    if seen.insert(p.clone()) {
        list.push(p);
    }
}

fn push_unique_define(
    list: &mut Vec<(String, Option<String>)>,
    seen: &mut HashSet<String>,
    def: (String, Option<String>),
) {
    if seen.insert(def.0.clone()) {
        list.push(def);
    }
}

// ============================================================================
// 1. compile_commands.json (CMake / GCC / Clang / Zephyr / ESP-IDF / Bear)
// ============================================================================

fn find_compile_commands_json(root: &Path) -> Option<PathBuf> {
    let candidates = [
        "compile_commands.json",
        "build/compile_commands.json",
        "out/compile_commands.json",
        "Debug/compile_commands.json",
        "Release/compile_commands.json",
        "cmake-build-debug/compile_commands.json",
        "cmake-build-release/compile_commands.json",
    ];
    for rel in candidates {
        let p = root.join(rel);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn shell_split(cmd: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            '\\' if in_double => {
                if let Some(&next) = chars.peek() {
                    if next == '"' || next == '\\' {
                        cur.push(chars.next().unwrap());
                    } else {
                        cur.push(c);
                    }
                } else {
                    cur.push(c);
                }
            }
            ch if ch.is_whitespace() && !in_single && !in_double => {
                if !cur.is_empty() {
                    tokens.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

fn detect_compiler_flavor_from_cmd(compiler_bin: &str) -> CompilerFlavor {
    let low = compiler_bin.to_ascii_lowercase();
    if low.contains("armclang") {
        CompilerFlavor::Armclang
    } else if low.contains("armcc") {
        CompilerFlavor::Armcc
    } else if low.contains("iccarm") {
        CompilerFlavor::IarArm
    } else if low.contains("iccrl78") {
        CompilerFlavor::IarRl78
    } else if low.contains("clang") {
        CompilerFlavor::Clang
    } else if low.contains("gcc") || low.contains("g++") || low.ends_with("/cc") || low == "cc" {
        CompilerFlavor::Gcc
    } else {
        CompilerFlavor::Unknown
    }
}

pub fn parse_compile_commands_json(root: &Path, cdb_path: &Path) -> Option<ProjectModel> {
    let text = read_text_auto(cdb_path)?;
    let val: Value = serde_json::from_str(&text).ok()?;
    let arr = val.as_array()?;
    if arr.is_empty() {
        return None;
    }

    let mut sources = Vec::new();
    let mut seen_src = HashSet::new();
    let mut include_dirs = Vec::new();
    let mut seen_inc = HashSet::new();
    let mut defines = Vec::new();
    let mut seen_def = HashSet::new();
    let mut flavor = CompilerFlavor::Unknown;

    for item in arr {
        let dir_str = item.get("directory").and_then(|v| v.as_str()).unwrap_or("");
        let base_dir = if !dir_str.is_empty() {
            PathBuf::from(dir_str)
        } else {
            root.to_path_buf()
        };

        if let Some(file_str) = item.get("file").and_then(|v| v.as_str()) {
            if let Some(p) = resolve_path(&base_dir, file_str) {
                push_unique_path(&mut sources, &mut seen_src, p);
            }
        }

        let tokens: Vec<String> = if let Some(args) = item.get("arguments").and_then(|v| v.as_array())
        {
            args.iter()
                .filter_map(|a| a.as_str().map(|s| s.to_string()))
                .collect()
        } else if let Some(cmd) = item.get("command").and_then(|v| v.as_str()) {
            shell_split(cmd)
        } else {
            Vec::new()
        };

        if flavor == CompilerFlavor::Unknown {
            if let Some(first) = tokens.first() {
                flavor = detect_compiler_flavor_from_cmd(first);
            }
        }

        let mut i = 0;
        while i < tokens.len() {
            let tok = &tokens[i];
            if tok == "-I" || tok == "-isystem" || tok == "-iquote" {
                if let Some(next) = tokens.get(i + 1) {
                    if let Some(p) = resolve_path(&base_dir, next) {
                        if p.is_dir() {
                            push_unique_path(&mut include_dirs, &mut seen_inc, p);
                        }
                    }
                    i += 2;
                    continue;
                }
            } else if let Some(rest) = tok.strip_prefix("-I") {
                if !rest.is_empty() {
                    if let Some(p) = resolve_path(&base_dir, rest) {
                        if p.is_dir() {
                            push_unique_path(&mut include_dirs, &mut seen_inc, p);
                        }
                    }
                }
            } else if let Some(rest) = tok.strip_prefix("-isystem") {
                if !rest.is_empty() {
                    if let Some(p) = resolve_path(&base_dir, rest) {
                        if p.is_dir() {
                            push_unique_path(&mut include_dirs, &mut seen_inc, p);
                        }
                    }
                }
            } else if tok == "-D" {
                if let Some(next) = tokens.get(i + 1) {
                    if let Some(d) = parse_define_token(next) {
                        push_unique_define(&mut defines, &mut seen_def, d);
                    }
                    i += 2;
                    continue;
                }
            } else if let Some(rest) = tok.strip_prefix("-D") {
                if let Some(d) = parse_define_token(rest) {
                    push_unique_define(&mut defines, &mut seen_def, d);
                }
            }
            i += 1;
        }
    }

    if sources.is_empty() && include_dirs.is_empty() {
        return None;
    }

    Some(ProjectModel {
        root_dir: root.to_path_buf(),
        source_kind: ProjectSourceKind::CompileCommands,
        targets: vec![BuildTarget {
            name: "compile_commands.json".to_string(),
            project_file: Some(cdb_path.to_path_buf()),
            compiler_flavor: flavor,
            sources,
            include_dirs,
            defines,
            excluded_files: Vec::new(),
        }],
        active_target_index: 0,
    })
}

// ============================================================================
// 2. Keil MDK (.uvprojx / .uvproj) via roxmltree
// ============================================================================

fn find_keil_project_file(root: &Path) -> Option<PathBuf> {
    let mut uvprojx: Vec<PathBuf> = Vec::new();
    let mut uvproj: Vec<PathBuf> = Vec::new();
    for entry in WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !e.file_type().is_dir()
                || !is_ignored_dir_name(&e.file_name().to_string_lossy())
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "uvprojx" {
            uvprojx.push(entry.path().to_path_buf());
        } else if ext == "uvproj" {
            uvproj.push(entry.path().to_path_buf());
        }
    }
    uvprojx.sort();
    uvproj.sort();
    uvprojx.into_iter().next().or_else(|| uvproj.into_iter().next())
}

fn first_child_text<'a>(node: roxmltree::Node<'a, 'a>, tag: &str) -> Option<&'a str> {
    node.children()
        .find(|n| n.is_element() && n.tag_name().name() == tag)
        .and_then(|n| n.text())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn find_descendant<'a>(
    node: roxmltree::Node<'a, 'a>,
    path: &[&str],
) -> Option<roxmltree::Node<'a, 'a>> {
    let mut cur = node;
    for &seg in path {
        cur = cur
            .children()
            .find(|n| n.is_element() && n.tag_name().name() == seg)?;
    }
    Some(cur)
}

fn is_keil_excluded(option_parent: roxmltree::Node, option_tag: &str) -> bool {
    if let Some(inc_node) = find_descendant(option_parent, &[option_tag, "CommonProperty", "IncludeInBuild"]) {
        if let Some(txt) = inc_node.text().map(str::trim) {
            return txt == "0";
        }
    }
    false
}

pub fn parse_keil_uvproj(root: &Path, proj_file: &Path) -> Option<ProjectModel> {
    let xml = read_text_auto(proj_file)?;
    let doc = roxmltree::Document::parse(&xml).ok()?;
    let proj_dir = proj_file.parent().unwrap_or(root);

    let mut targets = Vec::new();
    for target_node in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "Target")
    {
        let target_name = first_child_text(target_node, "TargetName")
            .unwrap_or("Target 1")
            .to_string();

        // Detect AC5 vs AC6
        let uac6 = target_node
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name() == "uAC6")
            .and_then(|n| n.text())
            .and_then(|t| t.trim().parse::<i32>().ok())
            .unwrap_or(0);
        let pcc_used = target_node
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name() == "pCCUsed")
            .and_then(|n| n.text())
            .unwrap_or("")
            .to_ascii_lowercase();
        let flavor = if uac6 > 0 || pcc_used.contains("armclang") || pcc_used.contains("ac6") {
            CompilerFlavor::Armclang
        } else {
            CompilerFlavor::Armcc
        };

        // IncludePath & Define under TargetOption/TargetArmAds/Cads/VariousControls
        let mut include_dirs = Vec::new();
        let mut seen_inc = HashSet::new();
        let mut defines = Vec::new();
        let mut seen_def = HashSet::new();

        let vc_node = find_descendant(
            target_node,
            &["TargetOption", "TargetArmAds", "Cads", "VariousControls"],
        )
        .or_else(|| {
            target_node
                .descendants()
                .find(|n| n.is_element() && n.tag_name().name() == "VariousControls")
        });

        if let Some(vc) = vc_node {
            if let Some(inc_str) = first_child_text(vc, "IncludePath") {
                for raw_inc in inc_str.split(';') {
                    if let Some(p) = resolve_path(proj_dir, raw_inc) {
                        if p.is_dir() {
                            push_unique_path(&mut include_dirs, &mut seen_inc, p);
                        }
                    }
                }
            }
            if let Some(def_str) = first_child_text(vc, "Define") {
                for raw_def in def_str.split(|c| c == ',' || c == ' ' || c == ';') {
                    if let Some(d) = parse_define_token(raw_def) {
                        push_unique_define(&mut defines, &mut seen_def, d);
                    }
                }
            }
        }

        // Groups -> Files (respecting IncludeInBuild=0 on both Group and File!)
        let mut sources = Vec::new();
        let mut seen_src = HashSet::new();
        let mut excluded_files = Vec::new();
        let mut seen_exc = HashSet::new();

        if let Some(groups_node) = find_descendant(target_node, &["Groups"]) {
            for group_node in groups_node
                .children()
                .filter(|n| n.is_element() && n.tag_name().name() == "Group")
            {
                let group_excluded = is_keil_excluded(group_node, "GroupOption");
                if let Some(files_node) = find_descendant(group_node, &["Files"]) {
                    for file_node in files_node
                        .children()
                        .filter(|n| n.is_element() && n.tag_name().name() == "File")
                    {
                        let file_excluded =
                            group_excluded || is_keil_excluded(file_node, "FileOption");
                        if let Some(fp_raw) = first_child_text(file_node, "FilePath") {
                            if let Some(resolved) = resolve_path(proj_dir, fp_raw) {
                                if file_excluded {
                                    push_unique_path(&mut excluded_files, &mut seen_exc, resolved);
                                } else {
                                    push_unique_path(&mut sources, &mut seen_src, resolved);
                                }
                            }
                        }
                    }
                }
            }
        }

        targets.push(BuildTarget {
            name: target_name,
            project_file: Some(proj_file.to_path_buf()),
            compiler_flavor: flavor,
            sources,
            include_dirs,
            defines,
            excluded_files,
        });
    }

    if targets.is_empty() {
        return None;
    }

    Some(ProjectModel {
        root_dir: root.to_path_buf(),
        source_kind: ProjectSourceKind::KeilUvprojx,
        targets,
        active_target_index: 0,
    })
}

// ============================================================================
// 3. IAR EWARM / RL78 (.eww / .ewp) via roxmltree
// ============================================================================

fn discover_and_parse_iar(root: &Path) -> Option<ProjectModel> {
    let mut eww_files: Vec<PathBuf> = Vec::new();
    let mut ewp_files: Vec<PathBuf> = Vec::new();

    for entry in WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !e.file_type().is_dir()
                || !is_ignored_dir_name(&e.file_name().to_string_lossy())
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "eww" {
            eww_files.push(entry.path().to_path_buf());
        } else if ext == "ewp" {
            ewp_files.push(entry.path().to_path_buf());
        }
    }

    let mut ordered_ewps: Vec<PathBuf> = Vec::new();
    let mut seen_ewp: HashSet<PathBuf> = HashSet::new();

    // Expand .eww workspaces first
    eww_files.sort();
    for eww in &eww_files {
        let ws_dir = eww.parent().unwrap_or(root);
        if let Some(xml) = read_text_auto(eww) {
            if let Ok(doc) = roxmltree::Document::parse(&xml) {
                for proj_node in doc
                    .descendants()
                    .filter(|n| n.is_element() && n.tag_name().name() == "project")
                {
                    if let Some(raw_p) = first_child_text(proj_node, "path") {
                        let expanded = raw_p
                            .replace("$WS_DIR$\\", "")
                            .replace("$WS_DIR$/", "")
                            .replace("$WS_DIR$", ".");
                        if let Some(p) = resolve_path(ws_dir, &expanded) {
                            if seen_ewp.insert(p.clone()) {
                                ordered_ewps.push(p);
                            }
                        }
                    }
                }
            }
        }
    }

    ewp_files.sort();
    for ewp in ewp_files {
        let canon = fs::canonicalize(&ewp).unwrap_or(ewp);
        if seen_ewp.insert(canon.clone()) {
            ordered_ewps.push(canon);
        }
    }

    if ordered_ewps.is_empty() {
        return None;
    }

    let mut targets = Vec::new();
    for ewp in &ordered_ewps {
        targets.extend(parse_iar_ewp(root, ewp));
    }

    if targets.is_empty() {
        return None;
    }

    // Prefer a Debug configuration if present
    let active_idx = targets
        .iter()
        .position(|t| t.name.to_ascii_lowercase().contains("debug"))
        .unwrap_or(0);

    Some(ProjectModel {
        root_dir: root.to_path_buf(),
        source_kind: ProjectSourceKind::IarEwp,
        targets,
        active_target_index: active_idx,
    })
}

pub fn parse_iar_ewp(root: &Path, ewp_file: &Path) -> Vec<BuildTarget> {
    let Some(xml) = read_text_auto(ewp_file) else {
        return Vec::new();
    };
    let Ok(doc) = roxmltree::Document::parse(&xml) else {
        return Vec::new();
    };
    let proj_dir = ewp_file.parent().unwrap_or(root);
    let proj_stem = ewp_file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("IAR");

    // Pre-collect all <file> elements with their excluded configuration names
    let mut all_files: Vec<(PathBuf, HashSet<String>)> = Vec::new();
    for file_node in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "file")
    {
        if let Some(raw_name) = first_child_text(file_node, "name") {
            let expanded = raw_name
                .replace("$PROJ_DIR$\\", "")
                .replace("$PROJ_DIR$/", "")
                .replace("$PROJ_DIR$", ".");
            if let Some(resolved) = resolve_path(proj_dir, &expanded) {
                let mut excl_cfgs = HashSet::new();
                if let Some(excl_node) = find_descendant(file_node, &["excluded"]) {
                    for cfg in excl_node
                        .children()
                        .filter(|n| n.is_element() && n.tag_name().name() == "configuration")
                    {
                        if let Some(txt) = cfg.text().map(str::trim) {
                            if !txt.is_empty() {
                                excl_cfgs.insert(txt.to_string());
                            }
                        }
                    }
                }
                all_files.push((resolved, excl_cfgs));
            }
        }
    }

    let mut targets = Vec::new();
    let root_elem = doc.root_element();
    for cfg_node in root_elem
        .children()
        .filter(|n| n.is_element() && n.tag_name().name() == "configuration")
    {
        let cfg_name = first_child_text(cfg_node, "name")
            .unwrap_or("Debug")
            .to_string();

        let tc_name = find_descendant(cfg_node, &["toolchain", "name"])
            .and_then(|n| n.text())
            .unwrap_or("ARM")
            .trim()
            .to_ascii_lowercase();
        let flavor = if tc_name.contains("rl78") {
            CompilerFlavor::IarRl78
        } else {
            CompilerFlavor::IarArm
        };

        let mut include_dirs = Vec::new();
        let mut seen_inc = HashSet::new();
        let mut defines = Vec::new();
        let mut seen_def = HashSet::new();

        for opt_node in cfg_node
            .descendants()
            .filter(|n| n.is_element() && n.tag_name().name() == "option")
        {
            let opt_name = first_child_text(opt_node, "name").unwrap_or("");
            if matches!(opt_name, "CCIncludePath2" | "CCIncludePath") {
                for st in opt_node
                    .children()
                    .filter(|n| n.is_element() && n.tag_name().name() == "state")
                {
                    if let Some(raw_inc) = st.text().map(str::trim) {
                        let expanded = raw_inc
                            .replace("$PROJ_DIR$\\", "")
                            .replace("$PROJ_DIR$/", "")
                            .replace("$PROJ_DIR$", ".");
                        if let Some(p) = resolve_path(proj_dir, &expanded) {
                            if p.is_dir() {
                                push_unique_path(&mut include_dirs, &mut seen_inc, p);
                            }
                        }
                    }
                }
            } else if matches!(opt_name, "CCDefines" | "CCDefines2") {
                for st in opt_node
                    .children()
                    .filter(|n| n.is_element() && n.tag_name().name() == "state")
                {
                    if let Some(raw_def) = st.text().map(str::trim) {
                        if let Some(d) = parse_define_token(raw_def) {
                            push_unique_define(&mut defines, &mut seen_def, d);
                        }
                    }
                }
            }
        }

        let mut sources = Vec::new();
        let mut seen_src = HashSet::new();
        let mut excluded_files = Vec::new();
        let mut seen_exc = HashSet::new();

        for (fp, excl_cfgs) in &all_files {
            if excl_cfgs.contains(&cfg_name) {
                push_unique_path(&mut excluded_files, &mut seen_exc, fp.clone());
            } else {
                push_unique_path(&mut sources, &mut seen_src, fp.clone());
            }
        }

        targets.push(BuildTarget {
            name: format!("{}:{}", proj_stem, cfg_name),
            project_file: Some(ewp_file.to_path_buf()),
            compiler_flavor: flavor,
            sources,
            include_dirs,
            defines,
            excluded_files,
        });
    }

    targets
}

// ============================================================================
// 4. Static GCC Makefile parser (zero shell execution, zero side effects)
// ============================================================================

fn find_makefile(root: &Path) -> Option<PathBuf> {
    for name in ["Makefile", "makefile", "GNUmakefile"] {
        let p = root.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    // Also check 1 level deep (e.g. gcc/Makefile)
    if let Ok(rd) = fs::read_dir(root) {
        let mut sub_dirs: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && !is_ignored_dir_name(
                        p.file_name().and_then(|s| s.to_str()).unwrap_or(""),
                    )
            })
            .collect();
        sub_dirs.sort();
        for sd in sub_dirs {
            for name in ["Makefile", "makefile"] {
                let p = sd.join(name);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

fn load_makefile_lines(makefile: &Path, depth: usize, visited: &mut HashSet<PathBuf>) -> Vec<String> {
    if depth > 4 {
        return Vec::new();
    }
    let canon = fs::canonicalize(makefile).unwrap_or_else(|_| makefile.to_path_buf());
    if !visited.insert(canon.clone()) {
        return Vec::new();
    }
    let Some(text) = read_text_auto(&canon) else {
        return Vec::new();
    };
    let base_dir = canon.parent().unwrap_or_else(|| Path::new("."));

    // Join backslash line continuations
    let mut joined: Vec<String> = Vec::new();
    let mut acc = String::new();
    for raw_line in text.lines() {
        let line = raw_line.trim_end_matches('\r');
        // Strip comments outside simple quotes
        let code = if let Some(pos) = line.find('#') {
            &line[..pos]
        } else {
            line
        };
        if let Some(without_bs) = code.trim_end().strip_suffix('\\') {
            acc.push_str(without_bs);
            acc.push(' ');
        } else {
            acc.push_str(code);
            let finished = std::mem::take(&mut acc);
            let trimmed = finished.trim();
            if !trimmed.is_empty() {
                // Handle `include foo.mk` / `-include foo.mk`
                if let Some(inc_rest) = trimmed
                    .strip_prefix("include ")
                    .or_else(|| trimmed.strip_prefix("-include "))
                    .or_else(|| trimmed.strip_prefix("sinclude "))
                {
                    for inc_tok in inc_rest.split_whitespace() {
                        if !inc_tok.contains('$') {
                            let inc_path = base_dir.join(inc_tok);
                            if inc_path.is_file() {
                                joined.extend(load_makefile_lines(&inc_path, depth + 1, visited));
                            }
                        }
                    }
                } else {
                    joined.push(finished);
                }
            }
        }
    }
    if !acc.trim().is_empty() {
        joined.push(acc);
    }
    joined
}

fn expand_make_vars(input: &str, vars: &HashMap<String, String>, base_dir: &Path) -> String {
    let mut cur = input.to_string();
    for _ in 0..8 {
        let mut changed = false;
        let mut out = String::with_capacity(cur.len());
        let bytes = cur.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'$' && i + 1 < bytes.len() && (bytes[i + 1] == b'(' || bytes[i + 1] == b'{') {
                let open = bytes[i + 1];
                let close = if open == b'(' { b')' } else { b'}' };
                let mut depth = 1usize;
                let mut j = i + 2;
                while j < bytes.len() && depth > 0 {
                    if bytes[j] == open {
                        depth += 1;
                    } else if bytes[j] == close {
                        depth -= 1;
                    }
                    j += 1;
                }
                if depth == 0 {
                    let inner = cur[i + 2..j - 1].trim();
                    if let Some(pat) = inner.strip_prefix("wildcard ") {
                        let expanded_pat = expand_make_vars(pat.trim(), vars, base_dir);
                        let matched = eval_static_wildcard(base_dir, &expanded_pat);
                        out.push_str(&matched.join(" "));
                        changed = true;
                        i = j;
                        continue;
                    } else if let Some(val) = vars.get(inner) {
                        out.push_str(val);
                        changed = true;
                        i = j;
                        continue;
                    }
                }
            }
            let ch = cur[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
        cur = out;
        if !changed {
            break;
        }
    }
    cur
}

fn eval_static_wildcard(base_dir: &Path, pattern_list: &str) -> Vec<String> {
    let mut results = Vec::new();
    for pat in pattern_list.split_whitespace() {
        let norm = pat.replace('\\', "/");
        if let Some((dir_part, file_pat)) = norm.rsplit_once('/') {
            let search_dir = base_dir.join(dir_part);
            if let Ok(rd) = fs::read_dir(&search_dir) {
                for entry in rd.flatten() {
                    let fname = entry.file_name().to_string_lossy().to_string();
                    if simple_glob_match(file_pat, &fname) {
                        results.push(format!("{}/{}", dir_part, fname));
                    }
                }
            }
        } else if let Ok(rd) = fs::read_dir(base_dir) {
            for entry in rd.flatten() {
                let fname = entry.file_name().to_string_lossy().to_string();
                if simple_glob_match(&norm, &fname) {
                    results.push(fname);
                }
            }
        }
    }
    results.sort();
    results
}

fn simple_glob_match(pat: &str, text: &str) -> bool {
    if pat == "*" {
        return true;
    }
    if let Some((prefix, suffix)) = pat.split_once('*') {
        text.starts_with(prefix) && text.ends_with(suffix) && text.len() >= prefix.len() + suffix.len()
    } else {
        pat == text
    }
}

pub fn parse_makefile_static(root: &Path, makefile_path: &Path) -> Option<ProjectModel> {
    let base_dir = makefile_path.parent().unwrap_or(root);
    let mut visited = HashSet::new();
    let lines = load_makefile_lines(makefile_path, 0, &mut visited);
    if lines.is_empty() {
        return None;
    }

    let mut vars: HashMap<String, String> = HashMap::new();

    for line in &lines {
        // Ignore recipe lines starting with tab
        if line.starts_with('\t') {
            continue;
        }
        // Parse `VAR := val`, `VAR += val`, `VAR ?= val`, `VAR = val`
        let trimmed = line.trim();
        if let Some(eq_idx) = trimmed.find('=') {
            let (lhs_raw, op_append, op_cond) = if eq_idx > 0 && trimmed.as_bytes()[eq_idx - 1] == b'+' {
                (&trimmed[..eq_idx - 1], true, false)
            } else if eq_idx > 0 && trimmed.as_bytes()[eq_idx - 1] == b':' {
                (&trimmed[..eq_idx - 1], false, false)
            } else if eq_idx > 0 && trimmed.as_bytes()[eq_idx - 1] == b'?' {
                (&trimmed[..eq_idx - 1], false, true)
            } else {
                (&trimmed[..eq_idx], false, false)
            };
            let var_name = lhs_raw.trim();
            if !var_name.is_empty()
                && var_name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                let rhs = trimmed[eq_idx + 1..].trim();
                if op_cond && vars.contains_key(var_name) {
                    continue;
                }
                if op_append {
                    let entry = vars.entry(var_name.to_string()).or_default();
                    if !entry.is_empty() && !rhs.is_empty() {
                        entry.push(' ');
                    }
                    entry.push_str(rhs);
                } else {
                    vars.insert(var_name.to_string(), rhs.to_string());
                }
            }
        }
    }

    // Detect compiler flavor from CC / PREFIX / CXX
    let cc_val = expand_make_vars(
        vars.get("CC")
            .or_else(|| vars.get("PREFIX"))
            .map(String::as_str)
            .unwrap_or(""),
        &vars,
        base_dir,
    );
    let flavor = {
        let f = detect_compiler_flavor_from_cmd(&cc_val);
        if f == CompilerFlavor::Unknown {
            CompilerFlavor::Gcc
        } else {
            f
        }
    };

    let mut sources = Vec::new();
    let mut seen_src = HashSet::new();
    let mut include_dirs = Vec::new();
    let mut seen_inc = HashSet::new();
    let mut defines = Vec::new();
    let mut seen_def = HashSet::new();

    // Expand all collected variables and inspect tokens
    for (var_name, raw_val) in &vars {
        let up = var_name.to_ascii_uppercase();
        let expanded = expand_make_vars(raw_val, &vars, base_dir);
        let tokens = shell_split(&expanded);

        let is_src_var = up.contains("SOURCE")
            || up.contains("SRC")
            || up.ends_with("_C")
            || up == "CSRCS"
            || up == "CPPSRCS";
        let is_inc_var = up.contains("INC");
        let is_def_var = up.contains("DEF");
        let is_flag_var = up.contains("FLAG") || up.contains("OPT") || is_inc_var || is_def_var;

        let mut i = 0;
        while i < tokens.len() {
            let tok = &tokens[i];
            if is_flag_var {
                if tok == "-I" || tok == "-isystem" {
                    if let Some(next) = tokens.get(i + 1) {
                        if let Some(p) = resolve_path(base_dir, next) {
                            if p.is_dir() {
                                push_unique_path(&mut include_dirs, &mut seen_inc, p);
                            }
                        }
                        i += 2;
                        continue;
                    }
                } else if let Some(rest) = tok.strip_prefix("-I") {
                    if !rest.is_empty() {
                        if let Some(p) = resolve_path(base_dir, rest) {
                            if p.is_dir() {
                                push_unique_path(&mut include_dirs, &mut seen_inc, p);
                            }
                        }
                    }
                } else if tok == "-D" {
                    if let Some(next) = tokens.get(i + 1) {
                        if let Some(d) = parse_define_token(next) {
                            push_unique_define(&mut defines, &mut seen_def, d);
                        }
                        i += 2;
                        continue;
                    }
                } else if let Some(rest) = tok.strip_prefix("-D") {
                    if let Some(d) = parse_define_token(rest) {
                        push_unique_define(&mut defines, &mut seen_def, d);
                    }
                } else if is_inc_var && !tok.starts_with('-') {
                    if let Some(p) = resolve_path(base_dir, tok) {
                        if p.is_dir() {
                            push_unique_path(&mut include_dirs, &mut seen_inc, p);
                        }
                    }
                } else if is_def_var && !tok.starts_with('-') {
                    if let Some(d) = parse_define_token(tok) {
                        push_unique_define(&mut defines, &mut seen_def, d);
                    }
                }
            }

            if is_src_var && !tok.starts_with('-') {
                let low = tok.to_ascii_lowercase();
                if low.ends_with(".c")
                    || low.ends_with(".cpp")
                    || low.ends_with(".cc")
                    || low.ends_with(".cxx")
                    || low.ends_with(".s")
                {
                    if let Some(p) = resolve_path(base_dir, tok) {
                        if p.is_file() {
                            push_unique_path(&mut sources, &mut seen_src, p);
                        }
                    }
                }
            }
            i += 1;
        }
    }

    if sources.is_empty() && include_dirs.is_empty() && defines.is_empty() {
        return None;
    }

    let target_name = vars
        .get("TARGET")
        .map(|s| expand_make_vars(s, &vars, base_dir))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Makefile".to_string());

    Some(ProjectModel {
        root_dir: root.to_path_buf(),
        source_kind: ProjectSourceKind::Makefile,
        targets: vec![BuildTarget {
            name: target_name,
            project_file: Some(makefile_path.to_path_buf()),
            compiler_flavor: flavor,
            sources,
            include_dirs,
            defines,
            excluded_files: Vec::new(),
        }],
        active_target_index: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_temp_dir(name: &str) -> PathBuf {
        let p = std::env::temp_dir()
            .join("chain_analysis_project_db_tests")
            .join(name);
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn test_parse_keil_uvprojx_multi_target_and_exclusions() {
        let dir = mk_temp_dir("keil_test");
        fs::create_dir_all(dir.join("MDK-ARM")).unwrap();
        fs::create_dir_all(dir.join("Core/Src")).unwrap();
        fs::create_dir_all(dir.join("Core/Inc")).unwrap();
        fs::create_dir_all(dir.join("Drivers/Old")).unwrap();
        fs::write(dir.join("Core/Src/main.c"), "int main(void) { return 0; }\n").unwrap();
        fs::write(dir.join("Core/Src/disabled.c"), "void dead(void) {}\n").unwrap();
        fs::write(dir.join("Drivers/Old/legacy.c"), "void legacy(void) {}\n").unwrap();
        fs::write(dir.join("Core/Inc/main.h"), "#define BUF_SZ 128\n").unwrap();

        let uvprojx = r#"<?xml version="1.0" encoding="UTF-8"?>
<Project>
  <Targets>
    <Target>
      <TargetName>STM32F4_AC6</TargetName>
      <TargetOption>
        <TargetCommonOption>
          <uAC6>1</uAC6>
        </TargetCommonOption>
        <TargetArmAds>
          <Cads>
            <VariousControls>
              <Define>USE_HAL_DRIVER, STM32F407xx, HSE_VALUE=8000000</Define>
              <IncludePath>..\Core\Inc</IncludePath>
            </VariousControls>
          </Cads>
        </TargetArmAds>
      </TargetOption>
      <Groups>
        <Group>
          <GroupName>App</GroupName>
          <Files>
            <File>
              <FilePath>..\Core\Src\main.c</FilePath>
            </File>
            <File>
              <FilePath>..\Core\Src\disabled.c</FilePath>
              <FileOption>
                <CommonProperty>
                  <IncludeInBuild>0</IncludeInBuild>
                </CommonProperty>
              </FileOption>
            </File>
          </Files>
        </Group>
        <Group>
          <GroupName>DisabledGroup</GroupName>
          <GroupOption>
            <CommonProperty>
              <IncludeInBuild>0</IncludeInBuild>
            </CommonProperty>
          </GroupOption>
          <Files>
            <File>
              <FilePath>..\Drivers\Old\legacy.c</FilePath>
            </File>
          </Files>
        </Group>
      </Groups>
    </Target>
  </Targets>
</Project>"#;
        fs::write(dir.join("MDK-ARM/demo.uvprojx"), uvprojx).unwrap();

        let model = discover_project_model(&dir);
        assert_eq!(model.source_kind, ProjectSourceKind::KeilUvprojx);
        let t = model.active_target().expect("target");
        assert_eq!(t.name, "STM32F4_AC6");
        assert_eq!(t.compiler_flavor, CompilerFlavor::Armclang);
        assert_eq!(t.sources.len(), 1);
        assert!(t.sources[0].ends_with("main.c"));
        assert_eq!(t.excluded_files.len(), 2);
        assert_eq!(t.include_dirs.len(), 1);
        assert!(t.include_dirs[0].ends_with("Inc"));
        assert!(t.defines.iter().any(|(k, v)| k == "USE_HAL_DRIVER" && v.is_none()));
        assert!(t.defines.iter().any(|(k, v)| k == "HSE_VALUE" && v.as_deref() == Some("8000000")));

        let cdb = model.build_compile_commands(None);
        assert_eq!(cdb.as_array().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_iar_ewp_with_exclusions() {
        let dir = mk_temp_dir("iar_test");
        fs::create_dir_all(dir.join("EWARM")).unwrap();
        fs::create_dir_all(dir.join("Src")).unwrap();
        fs::create_dir_all(dir.join("Inc")).unwrap();
        fs::write(dir.join("Src/app.c"), "int main(void){return 0;}\n").unwrap();
        fs::write(dir.join("Src/only_rel.c"), "void rel(void){}\n").unwrap();

        let ewp = r#"<?xml version="1.0" encoding="UTF-8"?>
<project>
  <configuration>
    <name>Debug</name>
    <toolchain><name>ARM</name></toolchain>
    <settings>
      <data>
        <option>
          <name>CCIncludePath2</name>
          <state>$PROJ_DIR$\..\Inc</state>
        </option>
        <option>
          <name>CCDefines</name>
          <state>STM32H743xx</state>
          <state>DEBUG=1</state>
        </option>
      </data>
    </settings>
  </configuration>
  <file>
    <name>$PROJ_DIR$\..\Src\app.c</name>
  </file>
  <file>
    <name>$PROJ_DIR$\..\Src\only_rel.c</name>
    <excluded>
      <configuration>Debug</configuration>
    </excluded>
  </file>
</project>"#;
        fs::write(dir.join("EWARM/app.ewp"), ewp).unwrap();

        let model = discover_project_model(&dir);
        assert_eq!(model.source_kind, ProjectSourceKind::IarEwp);
        let t = model.active_target().expect("iar target");
        assert_eq!(t.compiler_flavor, CompilerFlavor::IarArm);
        assert_eq!(t.sources.len(), 1);
        assert!(t.sources[0].ends_with("app.c"));
        assert_eq!(t.excluded_files.len(), 1);
        assert_eq!(t.include_dirs.len(), 1);
        assert!(t.defines.iter().any(|(k, v)| k == "DEBUG" && v.as_deref() == Some("1")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_makefile_static_gcc() {
        let dir = mk_temp_dir("makefile_test");
        fs::create_dir_all(dir.join("Core/Src")).unwrap();
        fs::create_dir_all(dir.join("Core/Inc")).unwrap();
        fs::write(dir.join("Core/Src/main.c"), "int main(void){return 0;}\n").unwrap();
        fs::write(dir.join("Core/Src/uart.c"), "void uart_init(void){}\n").unwrap();

        let mk = r#"
TARGET = demo_fw
PREFIX = arm-none-eabi-
CC = $(PREFIX)gcc

C_SOURCES = \
Core/Src/main.c \
$(wildcard Core/Src/uart*.c)

C_DEFS = \
-DUSE_HAL_DRIVER \
-DSTM32G474xx \
-DSYS_CLK=170000000

C_INCLUDES = \
-ICore/Inc
"#;
        fs::write(dir.join("Makefile"), mk).unwrap();

        let model = discover_project_model(&dir);
        assert_eq!(model.source_kind, ProjectSourceKind::Makefile);
        let t = model.active_target().expect("makefile target");
        assert_eq!(t.name, "demo_fw");
        assert_eq!(t.compiler_flavor, CompilerFlavor::Gcc);
        assert_eq!(t.sources.len(), 2);
        assert_eq!(t.include_dirs.len(), 1);
        assert!(t.defines.iter().any(|(k, _)| k == "STM32G474xx"));
        assert!(t.defines.iter().any(|(k, v)| k == "SYS_CLK" && v.as_deref() == Some("170000000")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_parse_compile_commands_json_gcc() {
        let dir = mk_temp_dir("cdb_test");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("inc")).unwrap();
        fs::create_dir_all(dir.join("build")).unwrap();
        fs::write(dir.join("src/main.c"), "int main(void){return 0;}\n").unwrap();

        let cdb = json!([
            {
                "directory": normalize_slash(&dir),
                "command": "arm-none-eabi-gcc -Iinc -DUSE_RTOS=1 -DMCU_F4 -c src/main.c -o build/main.o",
                "file": "src/main.c"
            }
        ]);
        fs::write(
            dir.join("build/compile_commands.json"),
            serde_json::to_string_pretty(&cdb).unwrap(),
        )
        .unwrap();

        let model = discover_project_model(&dir);
        assert_eq!(model.source_kind, ProjectSourceKind::CompileCommands);
        let t = model.active_target().expect("cdb target");
        assert_eq!(t.compiler_flavor, CompilerFlavor::Gcc);
        assert_eq!(t.sources.len(), 1);
        assert_eq!(t.include_dirs.len(), 1);
        assert!(t.defines.iter().any(|(k, v)| k == "USE_RTOS" && v.as_deref() == Some("1")));
        let _ = fs::remove_dir_all(&dir);
    }
}
