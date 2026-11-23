import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {
  analyzeLocalCProject,
  DEFAULT_CHERRYUSB_PATH,
} from "./src/server/cProjectAnalyzer";

const host = process.env.TAURI_DEV_HOST;

function localCAnalyzerPlugin(): Plugin {
  return {
    name: "local-c-analyzer-api",
    configureServer(server) {
      server.middlewares.use("/api/pick-folder", (_req, res) => {
        const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = "选择嵌入式 C/C++ 工程根目录"
$f.ShowNewFolderButton = $false
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$res = $f.ShowDialog($form)
if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $f.SelectedPath
}
`;
        execFile(
          "powershell.exe",
          ["-NoProfile", "-STA", "-Command", psScript],
          { timeout: 120000 },
          (err, stdout) => {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            if (err) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: err.message }));
              return;
            }
            const picked = stdout.trim();
            res.end(
              JSON.stringify({
                ok: true,
                cancelled: !picked,
                path: picked || null,
              })
            );
          }
        );
      });

      server.middlewares.use("/api/analyze", (req, res) => {
        try {
          const url = new URL(req.url || "", "http://localhost");
          const targetPath =
            url.searchParams.get("path")?.trim() || DEFAULT_CHERRYUSB_PATH;
          const result = analyzeLocalCProject(targetPath);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: true, project: result }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ ok: false, error: message }));
        }
      });

      server.middlewares.use("/api/export-porting", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body) as {
              repoPath: string;
              targetDir?: string;
              featureName: string;
              filesToCopy: string[];
              adapterFileName: string;
              adapterCode: string;
              portingGuideMd: string;
              projectFiles?: Record<string, string>;
            };

            const outBase =
              payload.targetDir?.trim() ||
              path.resolve(
                process.cwd(),
                "exported_ports",
                `port_${payload.featureName}`
              );

            fs.mkdirSync(outBase, { recursive: true });

            const copiedFiles: string[] = [];

            // Copy required .c/.h files (and common headers if CherryUSB)
            const filesSet = new Set(payload.filesToCopy);
            if (
              payload.repoPath &&
              fs.existsSync(path.join(payload.repoPath, "common"))
            ) {
              for (const entry of fs.readdirSync(
                path.join(payload.repoPath, "common")
              )) {
                if (entry.endsWith(".h")) {
                  filesSet.add(`common/${entry}`);
                }
              }
              if (
                fs.existsSync(
                  path.join(payload.repoPath, "cherryusb_config_template.h")
                )
              ) {
                filesSet.add("cherryusb_config_template.h");
              }
            }

            for (const relFile of filesSet) {
              const destPath = path.join(outBase, relFile);
              fs.mkdirSync(path.dirname(destPath), { recursive: true });

              const srcDiskPath = payload.repoPath
                ? path.join(payload.repoPath, relFile)
                : "";
              if (srcDiskPath && fs.existsSync(srcDiskPath)) {
                fs.copyFileSync(srcDiskPath, destPath);
                copiedFiles.push(relFile);
              } else if (payload.projectFiles && payload.projectFiles[relFile]) {
                fs.writeFileSync(
                  destPath,
                  payload.projectFiles[relFile],
                  "utf-8"
                );
                copiedFiles.push(relFile);
              }
            }

            // Write porting adapter skeleton .c
            const adapterPath = path.join(outBase, payload.adapterFileName);
            fs.writeFileSync(adapterPath, payload.adapterCode, "utf-8");
            copiedFiles.push(payload.adapterFileName);

            // Write PORTING_CHECKLIST.md
            const guidePath = path.join(outBase, "PORTING_CHECKLIST.md");
            fs.writeFileSync(guidePath, payload.portingGuideMd, "utf-8");
            copiedFiles.push("PORTING_CHECKLIST.md");

            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(
              JSON.stringify({
                ok: true,
                outputDir: outBase,
                copiedCount: copiedFiles.length,
                copiedFiles,
              })
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: false, error: message }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), localCAnalyzerPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "0.0.0.0",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/exported_ports/**", "**/*.exe"],
    },
  },
});
