import { assertEquals, assertRejects } from "@std/assert"
import { parse } from "@std/yaml"
import * as v from "valibot"

const workflow = v.parse(
  v.object({
    jobs: v.record(
      v.string(),
      v.looseObject({
        needs: v.optional(v.union([v.string(), v.array(v.string())])),
        if: v.optional(v.string()),
        steps: v.array(
          v.looseObject({
            id: v.optional(v.string()),
            with: v.optional(v.looseObject({ script: v.optional(v.string()) })),
          }),
        ),
      }),
    ),
  }),
  parse(await Deno.readTextFile(".github/workflows/issue-manifest-pr.yml")),
)
const script = workflow.jobs.prepare.steps.find((step) => step.id === "guard")
  ?.with?.script
const guard = new Function(
  "github",
  "context",
  "core",
  `return (async () => {${v.parse(v.string(), script)}})()`,
)

const snapshot = {
  number: 1,
  body: "manifest",
  updated_at: "2026-10-09T00:00:00Z",
  state: "open",
  labels: [{ name: "manifest" }],
  user: { login: "submitter", id: 123 },
}
const fixture = ({
  current = snapshot,
  sha = "a".repeat(40),
  statuses = [{
    context: "Issue manifest validation",
    creator: { login: "github-actions[bot]" },
    description: "Issue #1: validated",
  }],
  refError = 0,
} = {}) => {
  const outputs: Record<string, string> = {}
  const failures: string[] = []
  const writes: unknown[] = []
  const github = {
    rest: {
      issues: { get: () => Promise.resolve({ data: current }) },
      git: {
        getRef: () =>
          refError
            ? Promise.reject(
              Object.assign(new Error("GitHub API failed"), {
                status: refError,
              }),
            )
            : Promise.resolve({ data: { object: { sha } } }),
      },
      repos: {
        getCombinedStatusForRef: () => Promise.resolve({ data: { statuses } }),
        createCommitStatus: (value: unknown) => {
          writes.push(value)
          return Promise.resolve()
        },
      },
    },
  }
  const context = {
    repo: { owner: "example", repo: "registry" },
    payload: { issue: snapshot },
  }
  const core = {
    notice: () => {},
    setFailed: (message: string) => failures.push(message),
    setOutput: (key: string, value: string) => outputs[key] = value,
  }
  return {
    run: () => guard(github, context, core),
    outputs,
    failures,
    writes,
    github,
    context,
    core,
  }
}

Deno.test("publication guard refuses stale and closed issue snapshots", async () => {
  for (
    const current of [{ ...snapshot, body: "edited" }, {
      ...snapshot,
      state: "closed",
    }, { ...snapshot, labels: [] }]
  ) {
    const test = fixture({ current })
    await test.run()
    assertEquals(test.outputs, {})
    assertEquals(test.writes, [])
  }
})

Deno.test("publication guard refuses human or unverified branch heads", async () => {
  for (
    const statuses of [[], [{
      context: "Issue manifest validation",
      creator: { login: "human" },
      description: "Issue #1: validated",
    }], [{
      context: "Issue manifest validation",
      creator: { login: "github-actions[bot]" },
      description: "Issue #2: validated",
    }]]
  ) {
    const test = fixture({ statuses })
    await test.run()
    assertEquals(test.failures.length, 1)
    assertEquals(test.outputs, {})
    assertEquals(test.writes, [])
  }
})

Deno.test("publication guard invalidates an owned previous head and supplies its lease", async () => {
  const test = fixture()
  await test.run()
  assertEquals(test.outputs, { sha: "a".repeat(40), current: "true" })
  assertEquals(test.failures, [])
  assertEquals(test.writes, [{
    owner: "example",
    repo: "registry",
    sha: "a".repeat(40),
    state: "pending",
    context: "Issue manifest validation",
    description: "Issue #1: revalidation required",
  }])
})

Deno.test("publication guard treats only HTTP 404 as a missing branch", async () => {
  const missing = fixture({ refError: 404 })
  await missing.run()
  assertEquals(missing.outputs, { current: "true" })
  assertEquals(missing.writes, [])
  await assertRejects(fixture({ refError: 403 }).run)
})

Deno.test("publication guard recognizes the latest failed status as bot ownership", async () => {
  const test = fixture({
    statuses: [{
      context: "Issue manifest validation",
      creator: { login: "github-actions[bot]" },
      description: "Issue #1: update failed validation or publication",
    }],
  })
  await test.run()
  assertEquals(test.outputs.current, "true")
  assertEquals(test.failures, [])
})

Deno.test("failed validation still schedules terminal publication cleanup", () => {
  assertEquals(workflow.jobs.validate.needs, "prepare")
  const allowed = new Function(
    "needs",
    "always",
    `return ${workflow.jobs.publish.if}`,
  )
  assertEquals(
    allowed({
      prepare: { outputs: { current: "true", sha: "a".repeat(40) } },
      validate: { result: "failure", outputs: {} },
    }, () => true),
    true,
  )
})

const commitScript = v.parse(
  v.string(),
  workflow.jobs.publish.steps.find((step) => step.id === "commit")?.with
    ?.script,
)
const prepareCommit = new Function(
  "github",
  "context",
  "core",
  "require",
  "process",
  `return (async () => {${commitScript}})()`,
)

Deno.test("commit preparation exposes a SHA only after its ownership status succeeds", async () => {
  for (const failStatus of [false, true]) {
    const test = fixture()
    const operations: string[] = []
    const github = {
      ...test.github,
      rest: {
        ...test.github.rest,
        git: {
          getCommit: () =>
            Promise.resolve({ data: { tree: { sha: "base-tree" } } }),
          createBlob: () => Promise.resolve({ data: { sha: "new-blob" } }),
          createTree: () => Promise.resolve({ data: { sha: "new-tree" } }),
          createCommit: () => {
            operations.push("commit")
            return Promise.resolve({ data: { sha: "new-commit" } })
          },
        },
        repos: {
          getContent: () => Promise.resolve({ data: { sha: "old-blob" } }),
          createCommitStatus: () => {
            operations.push("status")
            return failStatus
              ? Promise.reject(new Error("status failed"))
              : Promise.resolve()
          },
        },
      },
    }
    const run = () =>
      prepareCommit(
        github,
        { ...test.context, sha: "base-commit" },
        test.core,
        () => ({ readFileSync: () => "id: demo\n" }),
        {
          env: {
            ID: "demo",
            OUT: "/artifact",
            RUN_URL: "https://github.com/example/registry/actions/runs/1",
          },
        },
      )
    if (failStatus) {
      await assertRejects(run, Error, "status failed")
      assertEquals(test.outputs, {})
    } else {
      await run()
      assertEquals(test.outputs, {
        sha: "new-commit",
        title: "fix: update demo manifest",
      })
    }
    assertEquals(operations, ["commit", "status"])
  }
})

const commentScript = v.parse(
  v.string(),
  workflow.jobs.publish.steps.find((step) =>
    step.with?.script?.includes("registry-index-issue-manifest")
  )?.with?.script,
)
const reportComment = new Function(
  "github",
  "context",
  "core",
  "require",
  "process",
  `return (async () => {${commentScript}})()`,
)

Deno.test("bot comment lookup stops at the first match or its page budget", async () => {
  for (const found of [true, false]) {
    const test = fixture()
    let pages = 0
    const edits: unknown[] = []
    const warnings: string[] = []
    const github = {
      ...test.github,
      rest: {
        ...test.github.rest,
        issues: {
          ...test.github.rest.issues,
          listComments: () => {},
          updateComment: (value: unknown) => {
            edits.push(value)
            return Promise.resolve()
          },
          createComment: () => {
            throw new Error(
              "must not duplicate an existing or unlocated comment",
            )
          },
        },
      },
      paginate: {
        iterator: () => ({
          [Symbol.asyncIterator]: () => ({
            next: () => {
              pages++
              if (pages > 10) throw new Error("unbounded comment scan")
              return Promise.resolve({
                done: false,
                value: {
                  data: found
                    ? [{
                      id: 1,
                      user: { login: "github-actions[bot]" },
                      body: "<!-- registry-index-issue-manifest --> old report",
                    }]
                    : Array.from(
                      { length: 100 },
                      () => ({ user: { login: "human" }, body: "comment" }),
                    ),
                },
              })
            },
          }),
        }),
      },
    }
    await reportComment(
      github,
      { ...test.context, issue: { number: 1 } },
      { ...test.core, warning: (message: string) => warnings.push(message) },
      () => ({ existsSync: () => false }),
      { env: {} },
    )
    assertEquals(pages, found ? 1 : 10)
    assertEquals(edits.length, found ? 1 : 0)
    assertEquals(warnings.length, found ? 0 : 1)
  }
})
