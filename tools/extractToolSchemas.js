/**
 * extractToolSchemas.js
 *
 * Extracts all built-in tool JSON schemas from a Claude Code binary by
 * spinning up a local HTTP proxy that intercepts the first API request
 * (which contains all tool definitions) and writes them to a JSON file.
 *
 * Usage:
 *   bun tools/extractToolSchemas.js [output-path]
 *
 * Requirements:
 *   - Bun runtime (used by Claude Code)
 *   - `claude` CLI available on PATH
 *
 * Output: JSON file with all tool schemas (defaults to ./tool-schemas/tools-{version}.json)
 */

import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, "..");
const SCHEMAS_DIR = join(ROOT_DIR, "tool-schemas");

const PORT = 18923 + Math.floor(Math.random() * 1000);
const TIMEOUT_MS = 30_000;

function getClaudeVersion() {
  const proc = Bun.spawnSync(["claude", "--version"]);
  return proc.stdout.toString().trim().split(" ")[0];
}

/** Recursively strip $schema keys from JSON schema objects */
function stripMetaSchema(obj) {
  if (Array.isArray(obj)) return obj.map(stripMetaSchema);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$schema") continue;
      out[k] = stripMetaSchema(v);
    }
    return out;
  }
  return obj;
}

async function main() {
  const version = getClaudeVersion();
  console.log(`Claude Code version: ${version}`);

  if (!existsSync(SCHEMAS_DIR)) {
    mkdirSync(SCHEMAS_DIR, { recursive: true });
  }

  const outputPath =
    process.argv[2] || join(SCHEMAS_DIR, `tools-${version}.json`);

  let claudeProc = null;
  let resolved = false;

  const result = await Promise.race([
    new Promise((resolve, reject) => {
      const server = Bun.serve({
        port: PORT,
        async fetch(req) {
          if (req.method !== "POST") return new Response("ok");

          let body;
          try {
            body = await req.json();
          } catch {
            return new Response(JSON.stringify({ error: "parse" }), {
              status: 200,
            });
          }

          if (body.tools && body.tools.length > 0 && !resolved) {
            resolved = true;

            const builtinTools = body.tools.filter(
              (t) => !t.name.startsWith("mcp__")
            );
            const mcpTools = body.tools.filter((t) =>
              t.name.startsWith("mcp__")
            );

            const output = {
              version,
              extractedAt: new Date().toISOString(),
              builtinToolCount: builtinTools.length,
              mcpToolCount: mcpTools.length,
              tools: builtinTools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: stripMetaSchema(t.input_schema),
              })),
            };

            await Bun.write(outputPath, JSON.stringify(output, null, 2));
            console.log(
              `\nCaptured ${builtinTools.length} built-in tools (ignored ${mcpTools.length} MCP tools)`
            );
            console.log(`Written to: ${outputPath}`);

            setTimeout(() => {
              server.stop();
              resolve(output);
            }, 200);
          }

          return new Response(
            JSON.stringify({
              id: "msg_extract",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "done" }],
              model: "claude-sonnet-4-20250514",
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        },
      });

      console.log(`Proxy listening on port ${PORT}`);

      // Launch Claude Code with flags to enable conditional tools
      claudeProc = spawn("claude", ["-p", "hi"], {
        env: {
          ...process.env,
          ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
          ANTHROPIC_API_KEY: "sk-ant-fake-extraction-key",
          CLAUDE_CODE_ENABLE_TASKS: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      claudeProc.stdin.end();
      claudeProc.on("error", (err) => {
        if (!resolved) reject(err);
      });
    }),

    new Promise((_, reject) =>
      setTimeout(() => {
        if (!resolved) reject(new Error(`Timeout after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS)
    ),
  ]);

  if (claudeProc) {
    try {
      claudeProc.kill();
    } catch {}
  }

  console.log("\nExtracted tools:");
  for (const tool of result.tools) {
    const props = tool.input_schema?.properties || {};
    const paramCount = Object.keys(props).length;
    console.log(`  ${tool.name} (${paramCount} params)`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
