import * as v from "valibot"
import { parse as parseYaml } from "@std/yaml"

const manifestBlock = /^### Manifest\n+```(?:yaml)?\n([\s\S]*?)\n```/m

const IssueManifest = v.looseObject({
  id: v.pipe(
    v.string(),
    v.regex(
      /^[A-Za-z0-9_-]+$/,
      "id can only contain letters, numbers, underscores, and hyphens",
    ),
  ),
})

export const issueManifest = (body: string) => {
  const content = body.replaceAll("\r\n", "\n").match(manifestBlock)?.[1]
  if (!content?.trim()) {
    throw new Error("The issue has no YAML block under `### Manifest`.")
  }
  const { id } = v.parse(IssueManifest, parseYaml(content))
  return { id, content: `${content.trim()}\n` }
}

if (import.meta.main) {
  try {
    const { id, content } = issueManifest(Deno.env.get("ISSUE_BODY") ?? "")
    await Deno.writeTextFile(`manifests/${id}.yaml`, content)
    console.log(id)
  } catch (error) {
    console.error(
      `error: ${error instanceof Error ? error.message : String(error)}`,
    )
    Deno.exit(1)
  }
}
