import { expect, test } from "bun:test";
import { sanitizedGitEnvironment } from "../src/git-environment.js";

test("child Git environment drops inherited command-scoped config tuples", () => {
  expect(
    sanitizedGitEnvironment({
      PATH: "/usr/bin",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: "*",
      GIT_DIR: "/kept/by-contract",
    }),
  ).toEqual({
    PATH: "/usr/bin",
    GIT_DIR: "/kept/by-contract",
  });
});
