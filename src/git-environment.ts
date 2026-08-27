const GIT_CONFIG_OVERRIDE_NAME = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;

/** Removes inherited command-scoped Git config tuples before invoking Git as a child process. */
export function sanitizedGitEnvironment(
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => !GIT_CONFIG_OVERRIDE_NAME.test(name)),
  );
}
