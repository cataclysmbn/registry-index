#!/usr/bin/env -S deno run --allow-read --allow-net
/** Check registry manifests locally and in CI. */

import * as v from "valibot"
import { parse as parseYaml } from "@std/yaml"
import { basename, extname, join, relative, resolve } from "@std/path"
import { canParse, compare, tryParse, tryParseRange } from "@std/semver"

type Manifest = Record<string, unknown>
export type Finding = {
  file: string
  field: string
  observed: string
  fix: string
  why: string
  severity: "error" | "warning"
  code: string
}
export type Change = {
  status: string
  code: string
  file: string
  oldFile?: string
}
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

const manifestExtension = /\.(?:ya?ml|json)$/i
const requestTimeout = 15_000
const jobTimeout = 480_000
const maxConcurrentRequests = 6
const skippedName = (file: string) => {
  const name = basename(file)
  return name.startsWith("_") || name.startsWith(".")
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const asText = (value: unknown) => {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return String(value)
  }
}
const finding = (
  file: string,
  field: string,
  observed: unknown,
  fix: string,
  why: string,
  code: string,
  severity: "error" | "warning" = "error",
): Finding => ({
  file,
  field,
  observed: asText(observed),
  fix,
  why,
  code,
  severity,
})

const ModIdPattern = /^(?=.*\S)[^/\\?#]+$/
const ModId = v.pipe(
  v.string("Mod ID must be a string"),
  v.minLength(1, "Mod ID cannot be empty"),
  v.regex(ModIdPattern, "Mod ID cannot be empty or contain /, \\, ?, or #"),
  v.check(
    (value) => !/\p{Cc}/u.test(value),
    "Mod ID cannot contain control characters",
  ),
)
const SemVer = v.custom<string>(
  (value) => typeof value === "string" && canParse(value),
  "Invalid SemVer format. Use MAJOR.MINOR.PATCH (e.g., 1.0.0)",
)
const Range = v.pipe(
  v.string("Version constraint must be a string"),
  v.minLength(1, "Version constraint cannot be empty"),
  v.check(
    (value) => tryParseRange(value) !== undefined,
    "Invalid SemVer range format. Use npm-style constraints such as >=1.0.0 or ^1.0.0",
  ),
)
const Dependencies = v.record(ModId, Range)
const Source = v.object({
  type: v.picklist(
    ["github_archive", "gitlab_archive", "direct_url"],
    "Type of source archive",
  ),
  url: v.pipe(
    v.string("Direct download URL for the archive (ZIP)"),
    v.url("Invalid URL format"),
  ),
  commit_sha: v.optional(
    v.pipe(
      v.string("Git commit SHA"),
      v.regex(/^[a-f0-9]{40}$/, "Invalid SHA format"),
    ),
  ),
  extract_path: v.optional(v.string("Path inside the archive")),
})
const Release = v.object({
  version: v.pipe(v.string("Release version"), SemVer),
  source: Source,
  released_at: v.optional(
    v.pipe(
      v.string("ISO 8601 timestamp"),
      v.isoTimestamp("Invalid ISO 8601 timestamp format"),
    ),
  ),
})
const AutoUpdate = v.looseObject({
  type: v.picklist(["tag", "commit"], "Method to check for new versions"),
  update_url: v.optional(v.string("URL to check for updates")),
  branch: v.optional(v.string("Branch to track")),
  regex: v.optional(v.string("Regex filter for tags")),
  url: v.optional(v.string("Release asset URL template")),
  icon_url: v.optional(v.string("Icon URL template")),
})
const ManifestSchema = v.pipe(
  v.object({
    schema_version: v.literal(
      "1.0",
      "Schema version for forward compatibility",
    ),
    package_type: v.optional(v.picklist(["mod", "soundpack"])),
    id: ModId,
    display_name: v.string("Human-readable display name"),
    short_description: v.pipe(
      v.string("Short description"),
      v.maxLength(200, "Short description must be 200 characters or less"),
    ),
    description: v.optional(v.string("Full description")),
    author: v.array(v.string("Mod author(s)")),
    license: v.fallback(v.string("License identifier"), "ALL-RIGHTS-RESERVED"),
    homepage: v.optional(
      v.pipe(v.string("Homepage URL"), v.url("Invalid URL format")),
    ),
    version: v.pipe(v.string("Current version"), SemVer),
    previous_releases: v.optional(v.array(Release, "Previous release history")),
    yanked: v.optional(
      v.object({
        reason: v.pipe(
          v.string("Yanked reason"),
          v.minLength(1, "Yanked reason cannot be empty"),
        ),
      }),
    ),
    dependencies: v.optional(Dependencies),
    conflicts: v.optional(Dependencies),
    source: Source,
    categories: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    icon_url: v.optional(v.string("Icon URL")),
    modinfo_url: v.optional(
      v.pipe(
        v.string("modinfo.json URL"),
        v.url("Invalid modinfo.json URL format"),
      ),
    ),
    uses_lua: v.optional(v.boolean()),
    lua_api_version: v.optional(v.pipe(v.number(), v.integer())),
    autoupdate: v.optional(AutoUpdate),
    parent: v.optional(ModId),
    last_updated: v.optional(
      v.pipe(
        v.string("ISO 8601 timestamp"),
        v.isoTimestamp("Invalid ISO 8601 timestamp format"),
      ),
    ),
  }),
  v.check(
    (manifest) => {
      const previous =
        manifest.previous_releases?.map((release) => release.version) ?? []
      return !previous.includes(manifest.version) &&
        new Set(previous).size === previous.length
    },
    "previous_releases must not include the current version and must not contain duplicates",
  ),
  v.check(
    (manifest) =>
      !manifest.parent ||
      manifest.parent.toLowerCase() !== manifest.id.toLowerCase(),
    "Mod cannot be its own parent",
  ),
  v.check((manifest) => {
    if (!manifest.dependencies || !manifest.conflicts) return true
    const dependencies = new Set(
      Object.keys(manifest.dependencies).map((id) => id.toLowerCase()),
    )
    return !Object.keys(manifest.conflicts).some((id) =>
      dependencies.has(id.toLowerCase())
    )
  }, "Mod cannot both depend on and conflict with the same mod"),
)

const generatedSourceSchema = {
  type: "object",
  properties: {
    type: { enum: ["github_archive", "gitlab_archive", "direct_url"] },
    url: { type: "string", format: "uri" },
    commit_sha: { type: "string", pattern: "^[a-f0-9]{40}$" },
    extract_path: { type: "string" },
  },
  required: ["type", "url"],
}
const generatedModIdSchema = {
  type: "string",
  minLength: 1,
  pattern: ModIdPattern.source,
}
const generatedDependenciesSchema = {
  type: "object",
  additionalProperties: { type: "string", minLength: 1 },
}
const canonicalGeneratedSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    schema_version: { const: "1.0" },
    package_type: { enum: ["mod", "soundpack"] },
    id: generatedModIdSchema,
    display_name: { type: "string" },
    short_description: { type: "string", maxLength: 200 },
    description: { type: "string" },
    author: { type: "array", items: { type: "string" } },
    license: { type: "string" },
    homepage: { type: "string", format: "uri" },
    version: { type: "string" },
    previous_releases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          version: { type: "string" },
          source: generatedSourceSchema,
          released_at: { type: "string", format: "date-time" },
        },
        required: ["version", "source"],
      },
    },
    yanked: {
      type: "object",
      properties: {
        reason: { type: "string", minLength: 1 },
      },
      required: ["reason"],
    },
    dependencies: generatedDependenciesSchema,
    conflicts: generatedDependenciesSchema,
    source: generatedSourceSchema,
    categories: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    icon_url: { type: "string" },
    modinfo_url: { type: "string", format: "uri" },
    uses_lua: { type: "boolean" },
    lua_api_version: { type: "integer" },
    autoupdate: {
      type: "object",
      properties: {
        type: { enum: ["tag", "commit"] },
        update_url: { type: "string" },
        branch: { type: "string" },
        regex: { type: "string" },
      },
      required: ["type"],
    },
    parent: generatedModIdSchema,
    last_updated: { type: "string", format: "date-time" },
  },
  required: [
    "schema_version",
    "id",
    "display_name",
    "short_description",
    "author",
    "license",
    "version",
    "source",
  ],
}
const normalizedJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizedJson)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizedJson(item)]),
  )
}
export const checkGeneratedSchema = async (
  root = Deno.cwd(),
): Promise<Finding[]> => {
  const file = "generated/mod_manifest.schema.json"
  let parsed: unknown
  try {
    parsed = JSON.parse(
      await Deno.readTextFile(join(root, "generated", "mod_manifest.schema.json")),
    )
  } catch (error) {
    return [
      finding(
        file,
        "<root>",
        "<unparseable>",
        "Regenerate generated/mod_manifest.schema.json from the canonical manifest schema and commit the result.",
        error instanceof Error ? error.message : String(error),
        "generated-schema-parse-error",
      ),
    ]
  }
  if (
    JSON.stringify(normalizedJson(parsed)) ===
      JSON.stringify(normalizedJson(canonicalGeneratedSchema))
  ) {
    return []
  }
  return [
    finding(
      file,
      "<root>",
      "<schema differs from canonical validator>",
      "Regenerate generated/mod_manifest.schema.json from the canonical manifest schema and commit the result.",
      "The checked-in generated schema and the validator must describe the same manifest structure.",
      "generated-schema-drift",
    ),
  ]
}

const issuePath = (issue: v.BaseIssue<unknown>) =>
  issue.path?.map((part) => "key" in part ? String(part.key) : "?").join(".") ||
  "<root>"
const valueAtPath = (value: unknown, path: string) =>
  path.split(".").reduce<unknown>((current, key) => {
    if (key === "<root>") return current
    return isObject(current) ? current[key] : undefined
  }, value)
export const checkCanonical = (file: string, value: unknown): Finding[] => {
  const result = v.safeParse(ManifestSchema, value)
  if (result.success) return []
  return result.issues.map((issue) => {
    const issueMessage = issue.message
    let field = issuePath(issue)
    let observed = valueAtPath(value, field)
    let fix =
      "Use the field type and example documented in manifests/README.md."
    const semantic = field === "<root>"
    if (issueMessage.includes("previous_releases")) {
      field = "previous_releases"
      observed = isObject(value) ? value.previous_releases : value
      fix =
        "Remove duplicate history entries and do not repeat the current version in previous_releases."
    } else if (issueMessage.includes("own parent")) {
      field = "parent"
      observed = isObject(value) ? value.parent : value
      fix = "Remove parent or set it to a different mod ID."
    } else if (issueMessage.includes("depend on and conflict")) {
      field = "dependencies/conflicts"
      observed = isObject(value)
        ? { dependencies: value.dependencies, conflicts: value.conflicts }
        : value
      fix = "Remove the same mod ID from either dependencies or conflicts."
    }
    return finding(
      file,
      field,
      observed,
      fix,
      issueMessage,
      semantic ? "manifest-semantic" : "manifest-schema",
    )
  })
}

export const parseManifest = (file: string, content: string): unknown =>
  extname(file).toLowerCase() === ".json"
    ? JSON.parse(content)
    : parseYaml(content)

export const readChanges = async (
  changesFile: string,
  root = Deno.cwd(),
): Promise<Change[]> => {
  const records = (await Deno.readTextFile(changesFile)).split("\0").filter((
    record,
  ) => record.length)
  const changes: Change[] = []
  for (let index = 0; index < records.length;) {
    const status = records[index++] ?? ""
    const code = status[0] ?? ""
    const firstFile = records[index++] ?? ""
    const renamed = code === "R" || code === "C"
    const secondFile = renamed ? records[index++] : undefined
    const file = renamed ? secondFile ?? firstFile : firstFile
    const relativeFile = relative(root, resolve(root, file))
    if (
      relativeFile.startsWith("manifests/") &&
      manifestExtension.test(relativeFile)
    ) {
      changes.push({
        status,
        code,
        file,
        oldFile: renamed ? firstFile : undefined,
      })
    }
  }
  return changes
}

const manifestFiles = async (
  root: string,
  paths: string[],
): Promise<string[]> => {
  const result: string[] = []
  const requested = paths.length ? paths : [join(root, "manifests")]
  for (const requestedPath of requested) {
    const absolute = resolve(root, requestedPath)
    try {
      const stat = await Deno.stat(absolute)
      if (stat.isFile && manifestExtension.test(absolute)) result.push(absolute)
      else if (stat.isDirectory) {
        for await (const entry of Deno.readDir(absolute)) {
          if (entry.isFile && manifestExtension.test(entry.name)) {
            result.push(join(absolute, entry.name))
          }
        }
      }
    } catch (error) {
      console.error(
        `Could not read ${requestedPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      result.push(absolute)
    }
  }
  return result.sort()
}

export const githubRepository = (
  value: string,
): { owner: string; repo: string } | null => {
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/|$)/i,
    /^([^/]+)\/([^/]+)$/,
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    if (match) {
      return { owner: match[1], repo: match[2].replace(/\.git$/, "") }
    }
  }
  return null
}
const repositoryUrl = (manifest: Manifest): string | null => {
  const update = isObject(manifest.autoupdate) ? manifest.autoupdate : {}
  for (
    const candidate of [
      update.update_url,
      manifest.homepage,
      isObject(manifest.source) ? manifest.source.url : null,
    ]
  ) {
    if (typeof candidate === "string") return candidate
  }
  return null
}

/** This is intentionally the same normalization used by registry/src/scripts/autoupdate.ts. */
export const updaterSemVer = (raw: string): string | null => {
  const stripped = raw.replace(/^[vV]/, "")
  const match = stripped.match(/^([^+-]+)([-+].*)?$/)
  if (!match) return null
  const parts = match[1].split(".")
  if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) {
    return null
  }
  const core = parts.map((part) =>
    part.length > 1 && part.startsWith("0") ? String(Number(part)) : part
  ).join(".")
  const normalized = `${core}${match[2] ?? ""}`
  return canParse(normalized) ? normalized : null
}
const compareUpdaterVersions = (left: string, right: string) => {
  const a = tryParse(left)
  const b = tryParse(right)
  return a && b ? compare(a, b) : left.localeCompare(right)
}
const validRegex = (regex: unknown): regex is string => {
  if (typeof regex !== "string") return false
  try {
    new RegExp(regex)
    return true
  } catch {
    return false
  }
}
const releaseAssetTemplate =
  'Add autoupdate.url: "https://github.com/owner/repo/releases/download/$version/package.zip" so future updates keep using the release asset.'
export const checkStaticSemantics = (
  file: string,
  manifest: Manifest,
): Finding[] => {
  const findings: Finding[] = []
  if (typeof manifest.id === "string") {
    const expected = `${manifest.id}${extname(file).toLowerCase()}`
    if (basename(file) !== expected) {
      findings.push(
        finding(
          file,
          "id",
          manifest.id,
          `Rename the file to manifests/${expected} (the exact basename must equal id).`,
          "The generated index and autoupdater use filenames as stable manifest identities.",
          "filename-id-mismatch",
        ),
      )
    }
  }
  const update = isObject(manifest.autoupdate) ? manifest.autoupdate : null
  if (!update) return findings
  if (
    update.type === "commit" && update.branch !== undefined &&
    (typeof update.branch !== "string" || !update.branch.trim())
  ) {
    findings.push(
      finding(
        file,
        "autoupdate.branch",
        update.branch,
        "Set branch to a non-empty branch name, or omit it to use main.",
        "Commit autoupdates resolve the latest commit from this branch.",
        "commit-branch",
      ),
    )
  }
  if (update.type !== "tag") return findings
  if (update.regex !== undefined && !validRegex(update.regex)) {
    findings.push(
      finding(
        file,
        "autoupdate.regex",
        update.regex,
        "Use a valid JavaScript regular expression, for example ^v?[0-9]+\\.[0-9]+\\.[0-9]+$.",
        "The updater constructs a JavaScript RegExp before filtering GitHub tags.",
        "tag-regex",
      ),
    )
  }
  for (const field of ["url", "icon_url"] as const) {
    const template = update[field]
    if (
      template !== undefined &&
      (typeof template !== "string" || !template.includes("$version"))
    ) {
      findings.push(
        finding(
          file,
          `autoupdate.${field}`,
          template,
          `Include $version in this template, for example https://github.com/owner/repo/${
            field === "url"
              ? "releases/download/$version/package.zip"
              : "raw/$version/icon.png"
          }.`,
          "The updater substitutes the raw tag only when the template contains $version.",
          `${field}-template`,
        ),
      )
    }
  }
  const sourceUrl =
    isObject(manifest.source) && typeof manifest.source.url === "string"
      ? manifest.source.url
      : ""
  if (
    /\/releases\/download\//.test(sourceUrl) && typeof update.url !== "string"
  ) {
    findings.push(
      finding(
        file,
        "autoupdate.url",
        "<missing>",
        releaseAssetTemplate,
        "Without this setting, the updater silently changes future downloads to GitHub tag archives instead of the release asset.",
        "missing-release-asset-template",
      ),
    )
  }
  return findings
}

const escapeAnnotation = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")
    .replaceAll(":", "%3A").replaceAll(",", "%2C")
export const findingMessage = (item: Finding) =>
  `field: ${item.field}; observed: ${item.observed}; problem: ${item.code}; exact fix: ${item.fix}; why it matters: ${item.why}`
export const renderReport = (findings: Finding[], notices: string[] = []) => {
  const lines = [
    "# Manifest validation report",
    "",
    "This report was generated from structured validator findings.",
    "",
  ]
  for (const notice of notices) lines.push(`- Notice: ${notice}`)
  if (!findings.length && !notices.length) lines.push("No problems found.")
  for (const item of findings) {
    lines.push(
      `- **${item.severity.toUpperCase()}** \`${item.file}\`, field \`${item.field}\`: ${item.observed}`,
    )
    lines.push(`  - Problem: ${item.code}`)
    lines.push(`  - Exact fix/example: ${item.fix}`)
    lines.push(`  - Why it matters: ${item.why}`)
  }
  return `${lines.join("\n")}\n`
}
export const capReport = (report: string, maxBytes = 58_000) => {
  const encoder = new TextEncoder()
  if (encoder.encode(report).length <= maxBytes) return report
  const suffix =
    `\n\nReport truncated safely at ${maxBytes} UTF-8 bytes. See the workflow log for the full diagnostics.\n`
  const available = maxBytes - encoder.encode(suffix).length
  let low = 0
  let high = report.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encoder.encode(report.slice(0, middle)).length <= available) {
      low = middle
    } else high = middle - 1
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(report[low - 1])) low--
  return `${report.slice(0, low)}${suffix}`
}

const withTimeout = async <T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
const request = async (
  url: string,
  init: RequestInit,
  fetcher: FetchLike,
): Promise<Response> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), requestTimeout)
  try {
    return await fetcher(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
type UrlCheckResult = {
  error?: string
  transient?: boolean
}
type GitHubApiResult = {
  value?: unknown
  error?: string
  transient?: boolean
}
const transientHttpStatus = (status: number) =>
  status === 408 || status === 425 || status === 429 || status >= 500
const httpResult = (response: Response): UrlCheckResult => {
  if (response.ok) return {}
  const transient = transientHttpStatus(response.status)
  return {
    error: `HTTP ${response.status} ${response.statusText}${
      transient ? "; transient failure, retry later" : ""
    }`,
    transient,
  }
}
const closeResponse = async (response: Response) => {
  if (response.body) await response.body.cancel()
}
const checkHttpUrl = (
  url: string,
  fetcher: FetchLike,
  cache: Map<string, Promise<UrlCheckResult>>,
): Promise<UrlCheckResult> => {
  const cached = cache.get(url)
  if (cached) return cached
  const result = (async (): Promise<UrlCheckResult> => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { error: "Invalid URL" }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `Unsupported URL protocol ${parsed.protocol}` }
    }
    try {
      const head = await request(
        url,
        { method: "HEAD", redirect: "follow" },
        fetcher,
      )
      const retryWithGet = head.status === 405 || head.status === 501
      const headResult = httpResult(head)
      await closeResponse(head)
      if (!retryWithGet) return headResult

      const get = await request(
        url,
        {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          redirect: "follow",
        },
        fetcher,
      )
      const getResult = httpResult(get)
      await closeResponse(get)
      return getResult
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        transient: true,
      }
    }
  })()
  cache.set(url, result)
  return result
}
const githubApi = (
  url: string,
  fetcher: FetchLike,
  cache: Map<string, Promise<GitHubApiResult>>,
) => {
  const cached = cache.get(url)
  if (cached) return cached
  const result = (async (): Promise<GitHubApiResult> => {
    try {
      const response = await request(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "registry-index-manifest-validator",
        },
      }, fetcher)
      const body = await response.text()
      if (!response.ok) {
        const rateLimited = response.status === 429 ||
          (response.status === 403 &&
            (response.headers.get("x-ratelimit-remaining") === "0" ||
              response.headers.has("retry-after")))
        const transient = rateLimited || transientHttpStatus(response.status)
        return {
          error:
            `GitHub API returned HTTP ${response.status} ${response.statusText}${
              transient ? "; transient service/rate-limit failure, retry later" : ""
            }`,
          transient,
        }
      }
      try {
        return { value: JSON.parse(body) }
      } catch {
        return {
          error: "GitHub API returned invalid JSON",
          transient: true,
        }
      }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        transient: true,
      }
    }
  })()
  cache.set(url, result)
  return result
}
const archiveUrl = (owner: string, repo: string, tag: string) =>
  `https://github.com/${owner}/${repo}/archive/refs/tags/${tag}.zip`
const generatedTagUrls = (
  manifest: Manifest,
  repo: { owner: string; repo: string },
  rawTag: string,
) => {
  const update = manifest.autoupdate as Record<string, unknown>
  const sourceUrl = typeof update.url === "string"
    ? update.url.replaceAll("$version", rawTag)
    : archiveUrl(repo.owner, repo.repo, rawTag)
  const iconUrl = typeof update.icon_url === "string"
    ? update.icon_url.replaceAll("$version", rawTag)
    : null
  return { sourceUrl, iconUrl }
}
export const checkNetwork = async (
  file: string,
  manifest: Manifest,
  fetcher: FetchLike,
  urlCache: Map<string, Promise<UrlCheckResult>> = new Map(),
  apiCache: Map<string, Promise<GitHubApiResult>> = new Map(),
): Promise<Finding[]> => {
  const findings: Finding[] = []
  const urls: [string, string][] = []
  const source = isObject(manifest.source) ? manifest.source : null
  for (
    const [field, value] of [["source.url", source?.url], [
      "icon_url",
      manifest.icon_url,
    ], ["modinfo_url", manifest.modinfo_url]] as [string, unknown][]
  ) if (typeof value === "string") urls.push([field, value])
  const urlChecks = await Promise.all(
    urls.map(async ([field, url]) =>
      [field, url, await checkHttpUrl(url, fetcher, urlCache)] as const
    ),
  )
  for (const [field, url, result] of urlChecks) {
    if (result.error) {
      const transient = result.transient === true
      findings.push(
        finding(
          file,
          field,
          url,
          transient
            ? "Retry the network check later; no manifest change is required unless the failure persists."
            : "Replace it with a reachable HTTPS URL and verify it locally with deno task check-urls.",
          `Installers need this resource; the network check observed ${result.error}.`,
          transient ? "url-check-transient" : "url-unreachable",
          transient ? "warning" : "error",
        ),
      )
    }
  }
  const update = isObject(manifest.autoupdate) ? manifest.autoupdate : null
  if (!update) return findings
  const repoUrl = repositoryUrl(manifest)
  const repo = repoUrl ? githubRepository(repoUrl) : null
  if (!repo) {
    findings.push(
      finding(
        file,
        "autoupdate.update_url",
        repoUrl ?? "<missing>",
        "Set update_url to a GitHub repository URL, or set homepage/source.url to one.",
        "The updater selects update_url, then homepage, then source.url to locate GitHub tags or commits.",
        "repository-not-github",
      ),
    )
    return findings
  }
  if (update.type === "commit") {
    const branch = typeof update.branch === "string" && update.branch
      ? update.branch
      : "main"
    const result = await githubApi(
      `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${
        encodeURIComponent(repo.repo)
      }/commits/${encodeURIComponent(branch)}`,
      fetcher,
      apiCache,
    )
    if (result.error) {
      const transient = result.transient === true
      findings.push(
        finding(
          file,
          "autoupdate.branch",
          branch,
          transient
            ? "Retry the GitHub API check later."
            : "Set branch to an existing branch and retry.",
          result.error,
          transient
            ? "commit-branch-check-transient"
            : "commit-branch-unreachable",
          transient ? "warning" : "error",
        ),
      )
    }
    return findings
  }
  if (update.type !== "tag") return findings
  const result = await githubApi(
    `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${
      encodeURIComponent(repo.repo)
    }/tags?per_page=100`,
    fetcher,
    apiCache,
  )
  if (result.error) {
    const transient = result.transient === true
    findings.push(
      finding(
        file,
        "autoupdate",
        repoUrl,
        transient
          ? "Retry the GitHub API check later; fork pull requests intentionally do not receive a token."
          : "Set update_url/homepage/source.url to a reachable GitHub repository.",
        result.error,
        transient ? "github-tags-check-transient" : "github-tags-unreachable",
        transient ? "warning" : "error",
      ),
    )
    return findings
  }
  const tags = Array.isArray(result.value)
    ? result.value.filter(isObject).map((tag) =>
      typeof tag.name === "string" ? tag.name : ""
    ).filter(Boolean)
    : []
  if (!tags.length) {
    findings.push(
      finding(
        file,
        "autoupdate.type",
        "tag",
        "Publish at least one GitHub tag with exactly three numeric SemVer components, such as v1.2.3.",
        "The updater reads the first 100 GitHub tags and has no version candidate when the repository has no tags.",
        "no-tags",
      ),
    )
    return findings
  }
  let regex: RegExp | undefined
  if (typeof update.regex === "string") {
    try {
      regex = new RegExp(update.regex)
    } catch {
      return findings
    }
  }
  const filtered = regex ? tags.filter((tag) => regex!.test(tag)) : tags
  if (!filtered.length) {
    findings.push(
      finding(
        file,
        "autoupdate.regex",
        update.regex,
        "Adjust or remove the regex so it matches at least one fetched GitHub tag, such as ^v?[0-9]+\\.[0-9]+\\.[0-9]+$.",
        "The updater applies the regex before SemVer conversion; filtering everything prevents updates.",
        "regex-filtered-all",
      ),
    )
    return findings
  }
  const candidates = filtered.map((tag) => ({
    tag,
    version: updaterSemVer(tag),
  })).filter((candidate): candidate is { tag: string; version: string } =>
    candidate.version !== null
  )
  if (!candidates.length) {
    findings.push(
      finding(
        file,
        "autoupdate",
        filtered,
        "Use a repository tag such as v1.2.3; a label like Release is not updater-compatible.",
        "The real updater accepts an optional v/V and exactly three numeric components, then applies SemVer parsing.",
        "no-compatible-semver-tag",
      ),
    )
    return findings
  }
  candidates.sort((left, right) =>
    compareUpdaterVersions(right.version, left.version)
  )
  const latest = candidates[0]
  const generated = generatedTagUrls(manifest, repo, latest.tag)
  const generatedUrls: [string, string][] = [[
    "future source.url",
    generated.sourceUrl,
  ]]
  if (generated.iconUrl) {
    generatedUrls.push(["future autoupdate.icon_url", generated.iconUrl])
  }
  const generatedResults = await Promise.all(
    generatedUrls.map(async ([field, url]) =>
      [field, url, await checkHttpUrl(url, fetcher, urlCache)] as const
    ),
  )
  for (const [field, url, result] of generatedResults) {
    if (result.error) {
      const transient = result.transient === true
      findings.push(
        finding(
          file,
          field,
          url,
          transient
            ? "Retry the network check later; no manifest change is required unless the failure persists."
            : "Make the $version template point to a reachable asset for the latest compatible tag, then rerun deno task check-urls.",
          `The updater selected ${latest.tag} and generated this URL; the network check observed ${result.error}.`,
          transient
            ? "generated-url-check-transient"
            : "generated-url-unreachable",
          transient ? "warning" : "error",
        ),
      )
    }
  }
  return findings
}

const loadOne = async (
  file: string,
): Promise<{ findings: Finding[]; manifest?: Manifest }> => {
  try {
    const parsed = parseManifest(file, await Deno.readTextFile(file))
    const findings = [...checkCanonical(file, parsed)]
    if (!isObject(parsed)) return { findings }
    findings.push(...checkStaticSemantics(file, parsed))
    return { findings, manifest: parsed }
  } catch (error) {
    return {
      findings: [
        finding(
          file,
          "<root>",
          "<unparseable>",
          "Fix the YAML/JSON syntax and rerun deno task validate.",
          error instanceof Error ? error.message : String(error),
          "parse-error",
        ),
      ],
    }
  }
}
export type ValidationResult = {
  findings: Finding[]
  notices: string[]
  report: string
}
export const checkFiles = async (
  files: string[],
  network = false,
  fetcher: FetchLike = fetch,
): Promise<ValidationResult> => {
  const findings: Finding[] = []
  const notices: string[] = []
  const urlCache = new Map<string, Promise<UrlCheckResult>>()
  const apiCache = new Map<string, Promise<GitHubApiResult>>()
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const file = files[next++]
      if (skippedName(file)) {
        notices.push(`Skipped template or dotfile manifest ${file}.`)
        continue
      }
      const loaded = await loadOne(file)
      findings.push(...loaded.findings)
      if (
        network && loaded.manifest &&
        !loaded.findings.some((item) => item.code === "parse-error")
      ) {
        findings.push(
          ...await checkNetwork(
            file,
            loaded.manifest,
            fetcher,
            urlCache,
            apiCache,
          ),
        )
      }
    }
  }
  await withTimeout(
    Promise.all(
      Array.from({
        length: Math.min(maxConcurrentRequests, Math.max(files.length, 1)),
      }, worker),
    ).then(() => undefined),
    jobTimeout,
    "manifest validation job",
  )
  return { findings, notices, report: renderReport(findings, notices) }
}

const printResult = (result: ValidationResult, reportPath?: string) => {
  for (const notice of result.notices) {
    console.error(
      `::notice title=Manifest validation notice::${escapeAnnotation(notice)}`,
    )
  }
  for (const item of result.findings) {
    const message = findingMessage(item)
    console.error(`${item.file}: ${item.severity}: ${message}`)
    console.error(
      `::${item.severity === "error" ? "error" : "warning"} file=${
        escapeAnnotation(item.file)
      },title=${escapeAnnotation(`Manifest ${item.code}`)}::${
        escapeAnnotation(message)
      }`,
    )
  }
  if (reportPath) Deno.writeTextFileSync(reportPath, capReport(result.report))
  console.log(
    result.findings.length
      ? `Found ${result.findings.length} manifest issue(s).`
      : "All manifests passed validation.",
  )
}
const main = async () => {
  const args = [...Deno.args]
  const mode = args[0] === "check-urls" || args[0] === "validate"
    ? args.shift()
    : "validate"
  let changesFile: string | undefined
  let reportPath: string | undefined
  const paths: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--changes-file") changesFile = args[++index]
    else if (arg.startsWith("--changes-file=")) changesFile = arg.slice(15)
    else if (arg === "--report") reportPath = args[++index]
    else if (arg.startsWith("--report=")) reportPath = arg.slice(9)
    else paths.push(arg)
  }
  const root = Deno.cwd()
  let files: string[]
  const notices: string[] = []
  if (changesFile) {
    const changes = await readChanges(changesFile, root)
    files = []
    for (const change of changes) {
      if (change.code === "D") {
        notices.push(
          `Deleted manifest ${change.file}; no content remains to validate.`,
        )
      } else if (!skippedName(change.file)) files.push(change.file)
      else notices.push(`Skipped template or dotfile manifest ${change.file}.`)
    }
    if (!files.length && !notices.length) {
      notices.push("No changed manifest files to validate.")
    }
  } else files = await manifestFiles(root, paths)
  const result = await checkFiles(files, mode === "check-urls")
  if (!changesFile) {
    result.findings.unshift(...await checkGeneratedSchema(root))
  }
  result.notices.unshift(...notices)
  result.report = renderReport(result.findings, result.notices)
  printResult(result, reportPath)
  if (result.findings.some((item) => item.severity === "error")) Deno.exit(1)
}
if (import.meta.main) await main()
