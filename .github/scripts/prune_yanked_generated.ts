import { parse } from "jsr:@std/yaml@1.0.10";
import { basename, join } from "jsr:@std/path@1.1.3";

const DEFAULT_ICON =
  "https://raw.githubusercontent.com/cataclysmbn/Cataclysm-BN/main/gfx/app_icon/app-icon.svg";

type Manifest = {
  id: string;
  display_name: string;
  short_description: string;
  author: string[];
  version: string;
  icon_url?: string;
  source: { url: string };
  yanked?: unknown;
  previous_releases?: unknown;
};

const [manifestDir = "manifests", generatedDir = "generated"] = Deno.args;

const manifests = [] as Manifest[];
for await (const entry of Deno.readDir(manifestDir)) {
  if (
    !entry.isFile || entry.name.startsWith("_") || !entry.name.match(/\.ya?ml$/)
  ) continue;
  const manifest = parse(
    await Deno.readTextFile(join(manifestDir, entry.name)),
  ) as Manifest;
  manifests.push(manifest);
}

const activeIds = new Set(
  manifests.filter((manifest) => !manifest.yanked).map((manifest) =>
    manifest.id
  ),
);
const modsJsonPath = join(generatedDir, "mods.json");
const generatedMods = JSON.parse(
  await Deno.readTextFile(modsJsonPath),
) as Manifest[];
const activeMods = generatedMods.filter((manifest) =>
  activeIds.has(manifest.id)
);

await Deno.writeTextFile(
  modsJsonPath,
  JSON.stringify(
    activeMods.map(({ previous_releases: _previousReleases, ...manifest }) =>
      manifest
    ),
    null,
    2,
  ) +
    "\n",
);

const modsDir = join(generatedDir, "mods");
for await (const entry of Deno.readDir(modsDir)) {
  if (
    entry.isFile && entry.name.endsWith(".json") &&
    !activeIds.has(basename(entry.name, ".json"))
  ) {
    await Deno.remove(join(modsDir, entry.name));
  }
}

const rows = activeMods.toSorted((a, b) =>
  a.display_name.localeCompare(b.display_name)
).map((mod) => {
  const iconUrl = mod.icon_url ?? DEFAULT_ICON;
  const description = mod.short_description.replaceAll("|", "\\|").trim();
  return `| ![Icon](${iconUrl}) | [${mod.display_name}](${mod.source.url}) | ${mod.author} | ${mod.version} | ${description} |`;
});

await Deno.writeTextFile(
  join(generatedDir, "mods.md"),
  `# Cataclysm: Bright Nights Mod Registry

This is an automatically generated list of mods in the registry.

| | Name | Author | Version | Description |
|-|------|--------|---------|-------------|
${rows.join("\n")}
`,
);

console.log(`Kept ${activeMods.length} active generated mods.`);
