import { assert, assertEquals, assertStringIncludes } from "@std/assert"
import {
  capReport,
  checkCanonical,
  checkGeneratedSchema,
  checkNetwork,
  checkStaticSemantics,
  commitVersion,
  githubRepository,
  parseManifest,
  readChanges,
  renderReport,
  updaterSemVer,
} from "./validate-manifests.ts"

const manifest = (id = "demo_mod"): Record<string, unknown> => ({
  schema_version: "1.0",
  id,
  display_name: "Demo",
  short_description: "A demo",
  author: ["Tester"],
  license: "MIT",
  version: "1.0.0",
  source: {
    type: "github_archive",
    url: "https://github.com/example/demo/archive/v1.0.0.zip",
  },
})

Deno.test("canonical schema rejects malformed fields and semantic conflicts", () => {
  const value = manifest("bad\u0001id")
  value.version = "1.0"
  value.dependencies = { bn: "not a range" }
  value.conflicts = { BN: ">=1.0.0" }
  value.parent = "bad\u0001id"
  value.previous_releases = [
    { version: "1.0.0", source: manifest().source },
    { version: "1.0.0", source: manifest().source },
  ]
  const findings = checkCanonical("manifests/bad.yaml", value)
  assert(findings.length >= 4)
  assert(findings.some((item) => item.observed.includes("bad")))
  assert(
    findings.some((item) =>
      item.why.includes("SemVer") || item.why.includes("control")
    ),
  )
  const duplicate = manifest()
  duplicate.previous_releases = [{ version: "1.0.0", source: duplicate.source }]
  assert(
    checkCanonical("manifests/demo_mod.yaml", duplicate).some((item) =>
      item.code === "manifest-semantic"
    ),
  )
  const selfParent = manifest()
  selfParent.parent = selfParent.id
  assert(
    checkCanonical("manifests/demo_mod.yaml", selfParent).some((item) =>
      item.code === "manifest-semantic"
    ),
  )
  const overlap = manifest()
  overlap.dependencies = { bn: ">=1.0.0" }
  overlap.conflicts = { BN: ">=1.0.0" }
  assert(
    checkCanonical("manifests/demo_mod.yaml", overlap).some((item) =>
      item.code === "manifest-semantic"
    ),
  )
})

Deno.test("observed values retain array indices and dotted dependency keys", () => {
  const value = manifest()
  value.author = [123]
  value.dependencies = { "broken.id": "not a range" }
  const issues = checkCanonical("manifests/demo_mod.yaml", value)
  assertEquals(
    issues.find((item) => item.field === "author.0")?.observed,
    "123",
  )
  assertEquals(
    issues.find((item) => item.field === "dependencies.broken.id")?.observed,
    '"not a range"',
  )
})

Deno.test("canonical schema accepts valid ranges, prereleases, and strict timestamps", () => {
  const value = manifest()
  value.version = "1.2.3-beta.1+build.9"
  value.dependencies = { bn: ">=0.12.0 <1.0.0" }
  value.previous_releases = [{
    version: "1.0.0",
    source: value.source,
    released_at: "2024-01-31T00:00:00Z",
  }]
  value.last_updated = "2024-02-01T00:00:00Z"
  assertEquals(checkCanonical("manifests/demo_mod.yaml", value), [])
})

Deno.test("matches updater GitHub repository parsing", () => {
  const url = githubRepository("https://github.com/example/demo.git")
  const nested = githubRepository("http://github.com/example/demo/tree/main")
  const shorthand = githubRepository("example/demo")
  assertEquals(url, { owner: "example", repo: "demo" })
  assertEquals(nested, { owner: "example", repo: "demo" })
  assertEquals(shorthand, { owner: "example", repo: "demo" })
  assertEquals(githubRepository("ftp://github.com/example/demo"), null)
  assertEquals(githubRepository("https://user@github.com/example/demo"), null)
  assertEquals(githubRepository("https://github.com:443/example/demo"), null)
})

Deno.test("requires the manifest filename to exactly match its id", () => {
  const issue = checkStaticSemantics(
    "manifests/thogs_zombies.yaml",
    manifest("thg_Thogs_Zs"),
  ).find((item) => item.code === "filename-id-mismatch")
  assert(issue)
  assertEquals(issue.observed, '"thg_Thogs_Zs"')
  assertStringIncludes(issue.fix, "manifests/thg_Thogs_Zs.yaml")
})

Deno.test("matches updater tag normalization and SemVer parsing", () => {
  assertEquals(updaterSemVer("v1.2.3"), "1.2.3")
  assertEquals(
    updaterSemVer("V01.002.3-beta.1+build.9"),
    "1.2.3-beta.1+build.9",
  )
  assertEquals(updaterSemVer("Release"), null)
  assertEquals(updaterSemVer("v1.2"), null)
  assertEquals(updaterSemVer("v1.2.3-beta..1"), null)
  assertEquals(updaterSemVer("v1.2.3-beta.01"), null)
  assertEquals(updaterSemVer("v999999999999999999999.2.3"), null)
})

Deno.test("reports the exact release asset template fix", () => {
  const value = manifest()
  value.source = {
    type: "direct_url",
    url: "https://github.com/example/demo/releases/download/Release/demo.zip",
  }
  value.autoupdate = { type: "tag" }
  const issue = checkStaticSemantics("manifests/demo_mod.yaml", value).find((
    item,
  ) => item.code === "missing-release-asset-template")
  assert(issue)
  assertStringIncludes(issue.fix, "autoupdate.url")
  assertStringIncludes(issue.fix, "$version")
})

const response = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Failure",
    headers: { "content-type": "application/json", ...headers },
  })
const networkManifest = () => {
  const value = manifest("network_mod")
  value.homepage = "https://github.com/example/demo"
  value.source = { type: "direct_url", url: "https://example.com/old.zip" }
  value.autoupdate = {
    type: "tag",
    update_url: "https://github.com/example/demo",
    url: "https://example.com/releases/$version/demo.zip",
    icon_url: "https://example.com/icons/$version.png",
  }
  return value
}

Deno.test("falls back to GET when a server rejects HEAD", async () => {
  const value = manifest("network_mod")
  value.source = { type: "direct_url", url: "https://example.com/archive.zip" }
  const methods: string[] = []
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    value,
    async (_url, init) => {
      await Promise.resolve()
      methods.push(init?.method ?? "GET")
      return init?.method === "HEAD" ? response("", 405) : response("ok")
    },
  )
  assertEquals(issues, [])
  assertEquals(methods, ["HEAD", "GET"])
})

Deno.test("reports transient URL failures as warnings", async () => {
  const value = manifest("network_mod")
  value.source = { type: "direct_url", url: "https://example.com/archive.zip" }
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    value,
    async () => {
      await Promise.resolve()
      return response("", 503)
    },
  )
  assertEquals(issues.length, 1)
  assertEquals(issues[0].code, "url-check-transient")
  assertEquals(issues[0].severity, "warning")
})

Deno.test("reports GitHub rate limits as warnings", async () => {
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    networkManifest(),
    async (url) => {
      await Promise.resolve()
      return String(url).includes("api.github.com")
        ? response(
          { message: "API rate limit exceeded" },
          403,
          { "x-ratelimit-remaining": "0" },
        )
        : response("ok")
    },
  )
  const issue = issues.find((item) =>
    item.code === "github-tags-check-transient"
  )
  assert(issue)
  assertEquals(issue.severity, "warning")
})

Deno.test("allows fixed tag URL and icon templates without $version", async () => {
  const value = networkManifest()
  value.autoupdate = {
    type: "tag",
    url: "https://example.com/latest/mod.zip",
    icon_url: "https://example.com/icon.png",
  }
  assertEquals(checkStaticSemantics("manifests/network_mod.yaml", value), [])
  const calls: string[] = []
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    value,
    async (url) => {
      await Promise.resolve()
      calls.push(String(url))
      return String(url).includes("api.github.com")
        ? response([{ name: "v1.2.3" }])
        : response("ok")
    },
  )
  assertEquals(issues, [])
  assert(calls.includes("https://example.com/latest/mod.zip"))
  assert(calls.includes("https://example.com/icon.png"))
})

Deno.test("reports a broken fixed tag URL after substitution", async () => {
  const value = networkManifest()
  value.autoupdate = {
    type: "tag",
    url: "https://example.com/latest/missing.zip",
  }
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    value,
    async (url) => {
      await Promise.resolve()
      if (String(url).includes("api.github.com")) {
        return response([{
          name: "v1.2.3",
        }])
      }
      return String(url).includes("missing.zip")
        ? response("missing", 404)
        : response("ok")
    },
  )
  assertEquals(
    issues.find((item) => item.code === "generated-url-unreachable")?.observed,
    '"https://example.com/latest/missing.zip"',
  )
})

Deno.test("resolves codeload source fallback using updater precedence", async () => {
  const value = manifest("network_mod")
  value.source = {
    type: "github_archive",
    url: "https://codeload.github.com/example/demo/zip/refs/tags/v1.0.0",
  }
  value.autoupdate = { type: "tag" }
  const calls: string[] = []
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    value,
    async (url) => {
      await Promise.resolve()
      calls.push(String(url))
      return String(url).includes("api.github.com")
        ? response([{ name: "v1.2.3" }])
        : response("ok")
    },
  )
  assertEquals(issues, [])
  assert(
    calls.includes(
      "https://api.github.com/repos/example/demo/tags?per_page=100",
    ),
  )
})

Deno.test("checks commit-generated URLs with updater CalVer rather than raw SHA", async () => {
  const value = networkManifest()
  value.autoupdate = {
    type: "commit",
    branch: "main",
    url: "https://example.com/releases/$version.zip",
    icon_url: "https://example.com/icons/$version.png",
  }
  const sha = "abcdef0123456789abcdef0123456789abcdef01"
  const version = commitVersion(sha)
  assertEquals(commitVersion(sha, new Date(2025, 0, 9)), "2025.1.9-abcdef0")
  const calls: string[] = []
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    value,
    async (url) => {
      await Promise.resolve()
      calls.push(String(url))
      if (String(url).includes("api.github.com")) return response({ sha })
      return String(url).includes(`${version}.zip`)
        ? response("missing", 404)
        : response("ok")
    },
  )
  assertEquals(
    issues.filter((item) => item.code === "generated-url-unreachable").length,
    1,
  )
  assert(calls.includes(`https://example.com/releases/${version}.zip`))
  assert(calls.includes(`https://example.com/icons/${version}.png`))
})

Deno.test("commit without templates retains current source and icon", async () => {
  const value = networkManifest()
  value.autoupdate = { type: "commit" }
  const calls: string[] = []
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    value,
    async (url) => {
      await Promise.resolve()
      calls.push(String(url))
      return String(url).includes("api.github.com")
        ? response({ sha: "a".repeat(40) })
        : response("ok")
    },
  )
  assertEquals(issues, [])
  assertEquals(calls.filter((url) => url.includes("old.zip")).length, 1)
})

Deno.test("aborts a stalled GitHub API response body", async () => {
  const value = networkManifest()
  let aborted = false
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    value,
    async (url, init) => {
      await Promise.resolve()
      if (!String(url).includes("api.github.com")) return response("ok")
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            aborted = true
            controller.error(new DOMException("Aborted", "AbortError"))
          })
        },
      })
      return new Response(body)
    },
  )
  assert(aborted)
  assert(issues.some((item) => item.code === "github-tags-check-transient"))
})

Deno.test("checks the generated schema against the canonical validator", async () => {
  assertEquals(await checkGeneratedSchema(), [])

  const root = await Deno.makeTempDir()
  await Deno.mkdir(`${root}/generated`)
  const schema = JSON.parse(
    await Deno.readTextFile("generated/mod_manifest.schema.json"),
  )
  schema.properties.id.minLength = 2
  await Deno.writeTextFile(
    `${root}/generated/mod_manifest.schema.json`,
    JSON.stringify(schema),
  )

  const issues = await checkGeneratedSchema(root)
  assertEquals(issues.length, 1)
  assertEquals(issues[0].code, "generated-schema-drift")
})

Deno.test("explains why a fixed Release tag cannot autoupdate", async () => {
  const value = networkManifest()
  const findings = await checkNetwork(
    "manifests/network_mod.yaml",
    value,
    async (url) => {
      await Promise.resolve()
      return String(url).includes("api.github.com")
        ? response([{ name: "Release" }])
        : response("ok")
    },
  )
  const issue = findings.find((item) =>
    item.code === "no-compatible-semver-tag"
  )
  assert(issue)
  assertStringIncludes(issue.fix, "v1.2.3")
  assertStringIncludes(issue.why, "exactly three numeric components")
})

Deno.test("checks substituted source and icon URLs for the selected latest tag", async () => {
  const calls: string[] = []
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    networkManifest(),
    async (url, init) => {
      await Promise.resolve()
      calls.push(`${init?.method ?? "GET"} ${String(url)}`)
      if (String(url).includes("api.github.com")) {
        return response([{
          name: "v1.2.3",
        }, { name: "v1.0.0" }])
      }
      if (String(url).includes("icons/")) return response("missing", 404)
      return response("ok")
    },
  )
  assert(issues.some((item) => item.code === "generated-url-unreachable"))
  assert(calls.some((call) => call.includes("releases/v1.2.3/demo.zip")))
  assert(calls.some((call) => call.includes("icons/v1.2.3.png")))
})

Deno.test("does not report fixed generated URLs when all substituted URLs are reachable", async () => {
  const issues = await checkNetwork(
    "manifests/network_mod.yaml",
    networkManifest(),
    async (url) => {
      await Promise.resolve()
      return String(url).includes("api.github.com")
        ? response([{ name: "v1.2.3" }])
        : response("ok")
    },
  )
  assertEquals(issues, [])
})

Deno.test("handles NUL-delimited rename, copy, delete, and Unicode records", async () => {
  const directory = await Deno.makeTempDir()
  const changes = [
    "R100",
    "manifests/old.yaml",
    "manifests/new.yaml",
    "C100",
    "manifests/old.yaml",
    "manifests/새 파일.yaml",
    "D",
    "manifests/deleted.yaml",
    "M",
    "docs/readme.md",
    "",
  ].join("\0")
  const changesFile = `${directory}/changes.z`
  await Deno.writeTextFile(changesFile, changes)
  const parsed = await readChanges(changesFile, directory)
  assertEquals(parsed.map((change) => change.code), ["R", "C", "D"])
  assertEquals(parsed[1].file, "manifests/새 파일.yaml")
  assertEquals(parsed[0].oldFile, "manifests/old.yaml")
})

Deno.test("parses YAML and keeps report text bounded", () => {
  const parsed = parseManifest("demo.yaml", "schema_version: 1.0\nid: demo\n")
  assert(parsed)
  const report = renderReport([{
    file: "manifests/x.yaml",
    field: "id",
    observed: "bad",
    fix: "rename it",
    why: "stable identity",
    severity: "error",
    code: "filename-id-mismatch",
  }])
  assertStringIncludes(report, "Exact fix/example")
  assert(capReport("a".repeat(100), 40).length <= 160)
  const unicode = capReport("한".repeat(100_000))
  assert(new TextEncoder().encode(unicode).length <= 58_000)
  assertStringIncludes(unicode, "UTF-8 bytes")
})
