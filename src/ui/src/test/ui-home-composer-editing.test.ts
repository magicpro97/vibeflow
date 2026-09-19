import { removeMentionAtKey } from "../home-composer-editing.js";

const { describe, expect, test } = await import(String("bun:test"));

type MockTextarea = Pick<HTMLTextAreaElement, "selectionStart" | "selectionEnd">;

describe("home composer editing", () => {
  test("removes chip for Backspace and Delete only", () => {
    const draft = "before +web_ui@codex after";
    const start = draft.indexOf("+web_ui@codex");
    const end = start + "+web_ui@codex".length;
    const remove = (key: string, caret: number) => {
      const prevented = { value: false };
      const event = {
        key,
        get defaultPrevented() {
          return prevented.value;
        },
        preventDefault() {
          prevented.value = true;
        },
      } as KeyboardEvent;
      const textarea = { selectionStart: caret, selectionEnd: caret } satisfies MockTextarea;
      return {
        removal: removeMentionAtKey(event, draft, textarea),
        prevented: event.defaultPrevented,
      };
    };
    expect(remove("Backspace", end + 1)).toEqual({
      removal: { draft: "before after", caret: start },
      prevented: true,
    });
    expect(remove("Delete", start)).toEqual({
      removal: { draft: "before after", caret: start },
      prevented: true,
    });
    expect(remove("ArrowLeft", end)).toEqual({ removal: null, prevented: false });
  });
});
