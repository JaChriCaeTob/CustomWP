# CustomWP Builder

CustomWP Builder is a local web app for generating pre-customized WordPress ZIP packages.

## What it does

- Select WordPress core version (`latest` or pinned).
- Search plugins from wordpress.org and queue installations by slug.
- Upload plugin `.zip` files directly.
- Apply backend branding:
  - admin bar brand text
  - admin footer text
  - custom login logo
- Apply frontend branding:
  - site title override
  - slogan override
  - frontend logo strip injection
  - accent color + custom CSS
- Export/import full build profiles (JSON).
- Build and download a ready-to-install WordPress package ZIP.

## Requirements

- Node.js 18+
- `zip` and `unzip` binaries available in PATH
- Internet access when running builds (WordPress core/plugin downloads)

## Run

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000).

## Build output

Generated ZIP files are saved under `builds/` and exposed through the UI download link.

The build includes:

- `wordpress/` core files
- requested plugins in `wordpress/wp-content/plugins`
- branding files in `wordpress/wp-content/customwp`
- MU plugin at `wordpress/wp-content/mu-plugins/customwp-branding.php`
- `wordpress/customwp-manifest.json` with build metadata

## Notes on plugin version selection

When you pick a WordPress core version, the tool resolves plugin versions using official wordpress.org plugin metadata.

- Default: install latest plugin version.
- If plugin minimum `requires` is higher than selected core, the tool attempts an older plugin release as fallback.

Because wordpress.org does not expose full per-release compatibility matrices for every plugin in one endpoint, the compatibility fallback is best-effort.
