import type { JSONObject, JSONValue } from "@ai-sdk/provider"
import type { BashObservation } from "./bash-provenance.js"

export type BashPresentation = {
  sdkName: string
  sdkInput: JSONObject
  displayInput: JSONObject
  nativeObservation?: BashObservation | null
  resultKind?: "native-output" | "rich" | "adapter-status"
  resultPrefix?: string | null
}

export function bashResultPresentation(presentation: BashPresentation, result: NonNullable<JSONValue>, observation?: BashObservation, interrupted = false) {
  const nativeObservation = observation ?? null
  const resultKind = interrupted ? "adapter-status" : typeof result === "string" ? "native-output" : "rich"
  const resultPrefix = typeof result === "string"
    ? `${observation ? `Native command (observed): ${observation.command}` : "Native command not observed"}\n\n--- ${interrupted ? "Adapter status" : "Native output"} ---\n`
    : null
  return {
    result: resultPrefix === null ? result : resultPrefix + result,
    presentation: { ...presentation, nativeObservation, resultKind, resultPrefix } satisfies BashPresentation,
  }
}

export function nativeToolPresentation(nativeName: string, input: string): {
  presentationName: string
  presentation?: BashPresentation
} {
  if (nativeName === "Bash") {
    try {
      const sdkInput: JSONValue = JSON.parse(input)
      if (sdkInput !== null && typeof sdkInput === "object" && !Array.isArray(sdkInput) && typeof sdkInput.command === "string") {
        const displayInput = JSON.parse(input) as JSONObject
        displayInput.command = `# Requested by Claude\n${sdkInput.command}`
        return { presentationName: "shell", presentation: { sdkName: nativeName, sdkInput, displayInput } }
      }
    } catch {}
  }
  return { presentationName: nativeName }
}
