import { assertEquals } from "@std/assert"
import { checkNetwork } from "./validate-manifests.ts"

Deno.test("network checks reject untrusted destinations before fetching", async () => {
  for (
    const url of [
      "http://github.com/demo/mod.zip",
      "https://127.0.0.1/mod.zip",
      "http://169.254.169.254/latest/meta-data/",
      "https://[::1]/mod.zip",
      "https://github.com.evil.example/mod.zip",
      "https://example.com/mod.zip",
      "https://user:password@github.com/demo/mod.zip",
      "https://github.com:8443/demo/mod.zip",
    ]
  ) {
    let calls = 0
    const findings = await checkNetwork("manifests/demo.yaml", {
      source: { url },
    }, () => {
      calls++
      return Promise.resolve(new Response(null, { status: 200 }))
    })
    assertEquals(calls, 0, url)
    assertEquals(findings.length, 1, url)
    assertEquals(findings[0].severity, "error", url)
  }
})

Deno.test("network checks reject untrusted redirects without requesting them", async () => {
  const calls: string[] = []
  const findings = await checkNetwork("manifests/demo.yaml", {
    source: { url: "https://github.com/demo/mod.zip" },
  }, (url, init) => {
    calls.push(String(url))
    assertEquals(init?.redirect, "manual")
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      }),
    )
  })
  assertEquals(calls, ["https://github.com/demo/mod.zip"])
  assertEquals(findings[0]?.severity, "error")
})

Deno.test("network checks follow relative and trusted archive redirects", async () => {
  const calls: string[] = []
  const findings = await checkNetwork("manifests/demo.yaml", {
    source: { url: "https://github.com/demo/mod.zip" },
  }, (url, init) => {
    calls.push(String(url))
    assertEquals(init?.redirect, "manual")
    return Promise.resolve(
      calls.length === 1
        ? new Response(null, {
          status: 302,
          headers: { location: "/demo/archive" },
        })
        : calls.length === 2
        ? new Response(null, {
          status: 302,
          headers: { location: "https://codeload.github.com/demo/archive" },
        })
        : new Response(null, { status: 200 }),
    )
  })
  assertEquals(findings, [])
  assertEquals(calls, [
    "https://github.com/demo/mod.zip",
    "https://github.com/demo/archive",
    "https://codeload.github.com/demo/archive",
  ])
})

Deno.test("network checks reject malformed redirect locations as errors", async () => {
  const findings = await checkNetwork("manifests/demo.yaml", {
    source: { url: "https://github.com/demo/mod.zip" },
  }, () =>
    Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://[invalid" },
      }),
    ))
  assertEquals(findings[0]?.severity, "error")
})

Deno.test("GitHub API checks reject redirects to untrusted hosts", async () => {
  const calls: string[] = []
  const findings = await checkNetwork("manifests/demo.yaml", {
    homepage: "https://github.com/demo/mod",
    autoupdate: { type: "commit" },
  }, (url) => {
    calls.push(String(url))
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/private" },
      }),
    )
  })
  assertEquals(calls, ["https://api.github.com/repos/demo/mod/commits/main"])
  assertEquals(findings[0]?.severity, "error")
})

Deno.test("network checks bound redirect loops and treat them as errors", async () => {
  let calls = 0
  const findings = await checkNetwork("manifests/demo.yaml", {
    source: { url: "https://github.com/demo/mod.zip" },
  }, () => {
    calls++
    return Promise.resolve(
      new Response(null, {
        status: 302,
        headers: { location: "/demo/mod.zip" },
      }),
    )
  })
  assertEquals(calls, 6)
  assertEquals(findings[0]?.severity, "error")
})
