# Cataclysm: Bright Nights Mod Manifests

This directory contains mod manifests for the BN mod registry.

## File Naming

- Use the mod's `id` as the filename (e.g., `dino_mod.yaml`)
- Use `.yaml` extension (preferred) or `.json`
- Prefixed files (`_*.yaml`) are examples/templates and will be skipped

## Adding a New Mod

1. Create a new YAML file with your mod's ID
2. Fill in all required fields (see schema below)
3. Run `deno task validate` to check your manifest
4. Submit a pull request

## Required Fields

```yaml
schema_version: "1.0"
id: your_mod_id
display_name: "Your Mod"
short_description: "..." # Max 200 chars
author:
  - "Your Name"
license: "MIT" # SPDX identifier
version: "1.0.0"
source:
  type: github_archive
  url: "https://..." # Direct download URL
```

## Optional Fields

- `description`: Full description
- `homepage`: Repository or documentation URL
- `dependencies`: List of required mod IDs
- `conflicts`: List of incompatible mod IDs
- `categories`: Organization categories
- `tags`: Search tags
- `icon_url`: 160x160 PNG icon URL
- `source.extract_path`: For modpacks, path inside archive
- `source.commit_sha`: Git commit for verification
- `autoupdate`: Auto-update configuration

## Modpack Extraction

For mods inside larger modpacks (like Kenan's), use `extract_path`:

```yaml
source:
  type: github_archive
  url: "https://github.com/user/modpack/archive/abc123.zip"
  extract_path: "modpack-abc123/Mods/YourMod"
```

## Autoupdate

For SemVer release tags such as `v1.2.3`, use:

```yaml
autoupdate:
  type: tag
  regex: "^v[0-9]" # optional: filter tags
  update_url: "https://github.com/user/repo"
  # Required when source.url downloads a release asset rather than a tag archive:
  url: "https://github.com/user/repo/releases/download/$version/package.zip"
  icon_url: "https://raw.githubusercontent.com/user/repo/$version/icon.png"
```

For the latest commit on a branch, use:

```yaml
autoupdate:
  type: commit
  branch: main # defaults to main when omitted
  update_url: "https://github.com/user/repo"
```

Tag updates only recognize SemVer tags with three numeric components. A fixed
tag such as `Release` cannot be autoupdated.

## Validation

Run these commands to validate your manifest:

```bash
deno task validate           # Parse every non-template manifest and validate the generated schema and semantic rules
deno task check-urls         # Also check source/icon/modinfo URLs and GitHub tag/commit updater behavior
```
