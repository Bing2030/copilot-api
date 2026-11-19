import { afterEach, describe, expect, mock, test } from "bun:test"

import {
  type ClackPromptBackend,
  prompt,
  promptWithClack,
  shouldUseClackPrompt,
} from "~/lib/interactive-prompt"

function createBackend(
  overrides: Partial<ClackPromptBackend>,
): ClackPromptBackend {
  return {
    isCancel: () => false,
    select: () => Promise.reject(new Error("Unexpected select prompt")),
    text: () => Promise.reject(new Error("Unexpected text prompt")),
    ...overrides,
  }
}

describe("interactive prompt compatibility", () => {
  const streamPropertyRestoreTasks: Array<() => void> = []

  function overrideStreamProperty(
    target: object,
    key: string,
    value: unknown,
  ): void {
    const record = target as Record<string, unknown>
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    streamPropertyRestoreTasks.push(() => {
      if (descriptor) {
        Object.defineProperty(record, key, descriptor)
      } else {
        delete record[key]
      }
    })
    Object.defineProperty(record, key, { value, configurable: true })
  }

  afterEach(() => {
    while (streamPropertyRestoreTasks.length > 0) {
      streamPropertyRestoreTasks.pop()?.()
    }
  })

  test("routes prompts through the Clack backend under Bun", async () => {
    // The test process is not interactive, so pretend it is.
    overrideStreamProperty(process.stdin, "isTTY", true)
    overrideStreamProperty(process.stdout, "isTTY", true)
    overrideStreamProperty(process.stdout, "getColorDepth", (): number => 8)

    await mock.module("@clack/prompts", () => ({
      isCancel: () => false,
      select: () => Promise.resolve("copilot"),
      text: () => Promise.resolve("entered"),
    }))

    expect(
      await prompt("Select a provider", {
        type: "select",
        options: ["copilot", "codex"],
      }),
    ).toBe("copilot")
    expect(await prompt("Enter value", { type: "text" })).toBe("entered")
  })

  test("uses Clack for an interactive Bun process on any platform", () => {
    expect(
      shouldUseClackPrompt({
        bunVersion: "1.4.2",
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stdoutIsTTYStream: true,
      }),
    ).toBe(true)

    expect(
      shouldUseClackPrompt({
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stdoutIsTTYStream: true,
      }),
    ).toBe(false)
    expect(
      shouldUseClackPrompt({
        bunVersion: "1.4.2",
        stdinIsTTY: false,
        stdoutIsTTY: true,
        stdoutIsTTYStream: true,
      }),
    ).toBe(false)
    expect(
      shouldUseClackPrompt({
        bunVersion: "1.4.2",
        stdinIsTTY: true,
        stdoutIsTTY: true,
        stdoutIsTTYStream: false,
      }),
    ).toBe(false)
  })

  test("maps select options and returns the selected value", async () => {
    let receivedOptions: Parameters<ClackPromptBackend["select"]>[0] | undefined
    const backend = createBackend({
      select: (options) => {
        receivedOptions = options
        return Promise.resolve("second")
      },
    })

    const value = await promptWithClack(
      "Pick one",
      {
        type: "select",
        initial: "first",
        options: [
          "first",
          { label: "Second option", value: "second", hint: "recommended" },
        ],
      },
      backend,
    )

    expect(value).toBe("second")
    expect(receivedOptions).toEqual({
      message: "Pick one",
      initialValue: "first",
      options: [
        { label: "first", value: "first" },
        { label: "Second option", value: "second", hint: "recommended" },
      ],
    })
  })

  test("maps text options and returns the entered value", async () => {
    let receivedOptions: Parameters<ClackPromptBackend["text"]>[0] | undefined
    const backend = createBackend({
      text: (options) => {
        receivedOptions = options
        return Promise.resolve("entered")
      },
    })

    const value = await promptWithClack(
      "Enter value",
      {
        type: "text",
        default: "fallback",
        initial: "initial",
        placeholder: "placeholder",
      },
      backend,
    )

    expect(value).toBe("entered")
    expect(receivedOptions).toEqual({
      message: "Enter value",
      defaultValue: "fallback",
      initialValue: "initial",
      placeholder: "placeholder",
    })
  })

  test("preserves Consola cancellation defaults", async () => {
    const cancelled = Symbol.for("clack:cancel")
    const backend = createBackend({
      isCancel: (value) => value === cancelled,
      select: () => Promise.resolve(cancelled),
      text: () => Promise.resolve(cancelled),
    })

    expect(
      await promptWithClack(
        "Pick one",
        {
          type: "select",
          initial: "first",
          options: ["first", "second"],
        },
        backend,
      ),
    ).toBe("first")
    expect(
      await promptWithClack(
        "Enter value",
        {
          type: "text",
          default: "fallback",
          initial: "initial",
        },
        backend,
      ),
    ).toBe("fallback")
  })
})
