import { assertEquals, assertThrows } from "@std/assert"
import { issueManifest } from "./issue-manifest.ts"

const body = (yaml: string) =>
  `### Manifest\r\n\r\n\`\`\`yaml\r\n${yaml}\r\n\`\`\`\r\n`

Deno.test("issueManifest extracts the issue form YAML and its id", () => {
  assertEquals(issueManifest(body("id: demo_mod\nversion: 1.0.0")), {
    id: "demo_mod",
    content: "id: demo_mod\nversion: 1.0.0\n",
  })
})

Deno.test("issueManifest rejects ids that are not safe filenames", () => {
  for (const id of ["../demo", "demo mod", "demo.yaml", ""]) {
    assertThrows(() => issueManifest(body(`id: "${id}"`)))
  }
})

Deno.test("issueManifest rejects bodies without a manifest block", () => {
  assertThrows(() => issueManifest("### Manifest\n\n_No response_"))
  assertThrows(() => issueManifest(body("id: [")))
})
