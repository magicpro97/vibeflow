/** Antigravity's `.agents/hooks.json` VibeFlow-owned key. */
export function antigravityHookConfig(cliPath: string): string {
  const command = `node "${cliPath}" hook --antigravity`;
  return JSON.stringify(
    {
      "vibeflow-guardrail": {
        PreToolUse: [
          {
            matcher: "write_to_file|replace_file_content|multi_replace_file_content|run_command",
            hooks: [{ type: "command", command, timeout: 60 }],
          },
        ],
        PostToolUse: [
          {
            matcher: "write_to_file|replace_file_content|multi_replace_file_content|run_command",
            hooks: [{ type: "command", command, timeout: 30 }],
          },
        ],
      },
    },
    null,
    2,
  );
}
