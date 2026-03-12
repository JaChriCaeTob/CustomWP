# CustomWP Builder

CustomWP Builder is a local web app for creating reusable WordPress packages.

It supports two build strategies:

- Snapshot mode: start from a ZIP of your current installation (recommended for cloning existing sites).
- Blueprint mode: assemble from wordpress.org core + plugin downloads.

## Requirements

- Node.js 18+
- `zip` and `unzip` in PATH
- Internet access for:
  - wordpress.org core/plugin APIs
  - live-site import/apply over REST

## Run

```bash
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000).

## Main workflow (existing site)

1. Create a ZIP snapshot of the existing WordPress install files (including `wp-content`, plugins, themes, uploads, and `wp-config.php` if possible).
2. In **Import Running Site**, enter URL + username + Application Password and click **Import Site Snapshot**.
3. Upload the file ZIP in **Current install snapshot ZIP**.
4. Keep **Build source** set to **Snapshot ZIP (preserve current install)**.
5. Optionally set `wp-config.php` DB fields.
6. Apply branding/customizations.
7. Click **Build WordPress Package** and download the reusable ZIP.

## Section-by-section field reference

### 0) Import Running Site

- `WordPress URL`
  - Base URL of the running site, for example `https://example.com` or subdirectory install URL.
  - Used for REST authentication and import.
- `Admin username`
  - WordPress username used with an Application Password.
- `Application password`
  - WordPress Application Password from that user profile.
  - Used instead of raw account password.
- `Import Site Snapshot`
  - Pulls site metadata from REST:
    - detected WordPress version
    - installed plugin slugs/versions (when endpoint allows)
    - title and tagline
  - Prefills builder fields.
- `Pull Snapshot ZIP From Live Site`
  - Downloads a filesystem snapshot directly from the live site.
  - Requires the CustomWP Live Branding Helper plugin to be installed.
- `Apply Title/Tagline To Live Site`
  - Pushes current builder title/tagline values back to live site via `/wp-json/wp/v2/settings`.
- `Current install snapshot ZIP`
  - ZIP of your actual site files.
  - Required when build source is Snapshot mode.

### 1) WordPress Core

- `Choose WordPress version`
  - Primary version selector for Blueprint mode.
  - In Snapshot mode, actual core comes from snapshot files; detected version is used in manifest when possible.

### 2) Plugin Installer

- `Search wordpress.org plugins`
  - Searches plugin directory and adds by slug.
- `Selected wordpress.org plugins`
  - Plugin queue for installation.
  - In Snapshot mode, if plugin folder already exists in snapshot, it is preserved (not re-downloaded).
- `Quick bundles`
  - Adds curated plugin slug sets (SEO / Performance / Security).
- `Upload plugin ZIP files`
  - Adds custom/private plugins from local `.zip` files.

### 3) Backend Branding

- `Admin bar brand name`
  - Replaces WordPress logo node text in admin bar.
- `Admin footer text`
  - Replaces admin footer text.
- `Login logo`
  - Custom login-screen logo.
- `Apply Backend Branding To Live Site`
  - Sends backend branding to the live site using the CustomWP Live Branding Helper plugin.
- `Download Live Branding Helper`
  - Downloads a helper plugin ZIP to install on the live site (Plugins → Add New → Upload Plugin).
- `Live Branding Settings`
  - The helper plugin adds **Settings → CustomWP Branding** for managing branding and downloading snapshots.

### 4) Frontend Branding

- `Site title override`
  - Runtime override for site title.
- `Site slogan`
  - Runtime override for tagline/description.
- `Frontend logo`
  - Injected at page start by branding MU plugin.
- `Accent color`
  - Exposed as CSS variable `--customwp-accent`.
- `Custom CSS`
  - Injected in frontend head.
- `Apply Title/Tagline To Live Site`
  - Sends the current title/tagline to the connected live site using stored credentials.

### 5) Build Source + wp-config.php

- `Build source`
  - `Snapshot ZIP (preserve current install)`
    - Uses uploaded snapshot as base filesystem.
    - Keeps existing core/plugins/themes/uploads/config.
    - Does not re-download core.
  - `Blueprint (download core/plugins)`
    - Builds from wordpress.org core and requested plugins.
- `DB name` (`DB_NAME`)
  - Sets database name in `wp-config.php`.
- `DB user` (`DB_USER`)
  - Sets database user.
- `DB password` (`DB_PASSWORD`)
  - Sets database password.
- `DB host` (`DB_HOST`)
  - Sets DB host, e.g. `localhost` or `db:3306`.
- `Table prefix`
  - Sets `$table_prefix` value.
- `WP_HOME (optional)`
  - Writes `define('WP_HOME', ...)`.
- `WP_SITEURL (optional)`
  - Writes `define('WP_SITEURL', ...)`.

### 6) Profiles & Validation

- `Validate Plugin Compatibility`
  - Resolves plugin install target version and shows compatibility notes.
- `Export Profile`
  - Exports full builder state JSON (including source mode and wp-config fields).
- `Import Profile`
  - Loads saved builder state JSON.

### 7) Build

- `Build WordPress Package`
  - Starts build job and streams logs.
- `Download Build ZIP`
  - Available after successful job completion.

## wp-config.php behavior

During build, `wp-config.php` is updated only for non-empty fields.

- If `wp-config.php` exists, it is patched in place.
- If missing but `wp-config-sample.php` exists, sample is copied to `wp-config.php` first.
- Existing values are replaced for provided fields only.

## Output

Build artifacts are written to `builds/` and downloadable in the UI.

Each ZIP contains:

- `wordpress/` root directory
- branding files under `wordpress/wp-content/customwp`
- branding MU plugin `wordpress/wp-content/mu-plugins/customwp-branding.php`
- `wordpress/customwp-manifest.json` with build metadata

## Important notes

- Live-site import uses REST API and depends on endpoint availability/permissions on that site.
- Snapshot mode is the safest option for preserving exact installed versions and existing file-level customizations.
- This tool packages filesystem state. Database content migration/export is out of scope in current version.
