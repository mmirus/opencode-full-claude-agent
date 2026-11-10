import { describe, expect, test } from "bun:test"
import { bashResultPresentation, nativeToolPresentation } from "../src/tool-presentation"

describe("nativeToolPresentation", () => {
  test.each(["", "printf 'hello\\n'", "printf 'first\\n'\nprintf 'second\\n'", "x".repeat(20_000)])("labels only the displayed Bash command without limiting its command", (command) => {
    const input = { command, description: "Native description", timeout: 120_000, extra: { nested: [true, null, 1] } }
    expect(nativeToolPresentation("Bash", JSON.stringify(input))).toEqual({
      presentationName: "shell", presentation: { sdkName: "Bash", sdkInput: input,
        displayInput: { ...input, command: `# Requested by Claude\n${command}` } },
    })
  })

  test.each(["not JSON", "null", "[]", "true", "42", '"command"', "{}", '{"command":null}', '{"command":42}', '{"command":[]}'])
    ("retains native Bash for malformed input %s", (input) => {
      expect(nativeToolPresentation("Bash", input)).toEqual({ presentationName: "Bash" })
    })

  test.each(["Write", "Read", "Edit", "Agent", "bash", "shell", "mcp__server__Bash"])("does not map %s", (name) => {
    expect(nativeToolPresentation(name, '{"command":"pwd","file_path":"x","content":"y"}'))
      .toEqual({ presentationName: name })
  })

  test("keeps the SDK and display input snapshots independent", () => {
    const input = { command: "pwd", extra: { nested: [true, null, 1] } }
    const { presentation } = nativeToolPresentation("Bash", JSON.stringify(input))
    if (!presentation) throw new Error("Missing Bash presentation")
    presentation.displayInput.extra = "display-only"
    expect(presentation.sdkInput).toEqual(input)
    input.extra.nested.push(2)
    expect(presentation.sdkInput).toEqual({ command: "pwd", extra: { nested: [true, null, 1] } })
  })
})

describe("bashResultPresentation", () => {
  const input = { command: "requested" }
  const presentation = { sdkName: "Bash", sdkInput: input, displayInput: { command: "# Requested by Claude\nrequested" } }

  test("keeps native output recoverable from the documented result prefix", () => {
    const output = "unaltered\n\n--- Native output ---\noutput"
    const displayed = bashResultPresentation(presentation, output, { command: "observed", source: "PostToolUse" })
    expect(displayed.presentation).toEqual({ ...presentation,
      nativeObservation: { command: "observed", source: "PostToolUse" }, resultKind: "native-output",
      resultPrefix: "Native command (observed): observed\n\n--- Native output ---\n",
    })
    expect(displayed.result).toBe(displayed.presentation.resultPrefix + output)
    expect(JSON.stringify(displayed.presentation)).not.toContain("unaltered")
  })

  test("retains rich result identity and records missing observation explicitly", () => {
    const output = [{ type: "text", text: "body" }, { type: "image", source: { data: "image" } }]
    const displayed = bashResultPresentation(presentation, output)
    expect(displayed.result).toBe(output)
    expect(displayed.presentation).toEqual({ ...presentation, nativeObservation: null, resultKind: "rich", resultPrefix: null })
  })

  test("labels a synthetic interruption as adapter status, not native output", () => {
    const displayed = bashResultPresentation(presentation, "Unknown outcome", undefined, true)
    expect(displayed.result).toBe("Native command not observed\n\n--- Adapter status ---\nUnknown outcome")
    expect(displayed.presentation).toEqual({ ...presentation, nativeObservation: null, resultKind: "adapter-status",
      resultPrefix: "Native command not observed\n\n--- Adapter status ---\n" })
  })
})
