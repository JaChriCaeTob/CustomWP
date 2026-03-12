const http = require('http');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');
const BUILD_DIR = path.join(ROOT, 'builds');
const TMP_DIR = path.join(ROOT, 'tmp');

const jobs = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function compareVersions(a, b) {
  const aParts = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const bParts = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  const max = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < max; i += 1) {
    const x = aParts[i] || 0;
    const y = bParts[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }

  return 0;
}

function isVersionLike(input) {
  return /^[0-9]+(?:\.[0-9]+)*$/.test(String(input));
}

function normalizeSlug(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function createHttpError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeSiteUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) {
    throw createHttpError('Site URL is required', 400);
  }

  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw createHttpError('Invalid site URL', 400);
  }

  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');

  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

function joinSiteUrl(baseUrl, endpoint) {
  return new URL(endpoint.replace(/^\//, ''), `${baseUrl}/`).toString();
}

function buildBasicAuthHeader(username, appPassword) {
  const user = String(username || '').trim();
  const pass = String(appPassword || '').trim();
  if (!user || !pass) {
    throw createHttpError('Username and application password are required', 400);
  }
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function extractWpVersionFromGenerator(generator) {
  const match = String(generator || '').match(/[?&]v=([0-9]+(?:\.[0-9]+){0,3})/i);
  return match ? match[1] : null;
}

function pluginEntryToSlug(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.plugin && typeof entry.plugin === 'string') {
    return normalizeSlug(entry.plugin.split('/')[0]);
  }
  if (entry.slug && typeof entry.slug === 'string') {
    return normalizeSlug(entry.slug);
  }
  return '';
}

function pluginEntryToVersion(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const version = String(entry.version || '').trim();
  return isVersionLike(version) ? version : '';
}

function inferMimeType(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  return 'application/octet-stream';
}

function toDataUrl(fileObj) {
  if (!fileObj || !fileObj.dataBase64) return '';
  const mime = inferMimeType(fileObj.filename);
  return `data:${mime};base64,${fileObj.dataBase64}`;
}

async function ensureDirs() {
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });
  await fsp.mkdir(BUILD_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  const maxBytes = 450 * 1024 * 1024;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error('Request payload too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Invalid JSON payload');
    err.statusCode = 400;
    throw err;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.json();
}

async function fetchJsonWithAuth(url, authHeader, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.headers || {}),
      Authorization: authHeader
    }
  });

  const contentType = response.headers.get('content-type') || '';
  let payload = null;
  let raw = '';

  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    raw = await response.text();
  }

  if (!response.ok) {
    const detail = payload?.message || raw.slice(0, 200) || `Request failed (${response.status})`;
    throw createHttpError(detail, response.status);
  }

  if (payload !== null) return payload;

  try {
    return JSON.parse(raw);
  } catch {
    throw createHttpError(`Unexpected non-JSON response from ${url}`, 502);
  }
}

async function importLiveSiteProfile(body) {
  const siteUrl = normalizeSiteUrl(body.siteUrl);
  const authHeader = buildBasicAuthHeader(body.username, body.appPassword);
  const warnings = [];

  const rootInfo = await fetchJsonWithAuth(joinSiteUrl(siteUrl, '/wp-json'), authHeader);
  const userInfo = await fetchJsonWithAuth(
    joinSiteUrl(siteUrl, '/wp-json/wp/v2/users/me?context=edit'),
    authHeader
  );

  let settings = null;
  try {
    settings = await fetchJsonWithAuth(joinSiteUrl(siteUrl, '/wp-json/wp/v2/settings'), authHeader);
  } catch (error) {
    warnings.push(
      `Could not read site settings from /wp/v2/settings: ${error.message}. Continuing with defaults.`
    );
  }

  let pluginEntries = [];
  try {
    const plugins = await fetchJsonWithAuth(
      joinSiteUrl(siteUrl, '/wp-json/wp/v2/plugins?per_page=100'),
      authHeader
    );
    pluginEntries = Array.isArray(plugins) ? plugins : [];
  } catch (error) {
    warnings.push(
      `Could not read installed plugins from /wp/v2/plugins: ${error.message}. You can still add plugins manually.`
    );
  }

  const wpVersion = extractWpVersionFromGenerator(rootInfo?.generator) || 'latest';
  const pluginBySlug = new Map();
  for (const entry of pluginEntries) {
    const slug = pluginEntryToSlug(entry);
    if (!slug) continue;
    if (pluginBySlug.has(slug)) continue;
    pluginBySlug.set(slug, pluginEntryToVersion(entry));
  }

  const profile = {
    wpVersion,
    plugins: Array.from(pluginBySlug.entries()).map(([slug, version]) => ({
      slug,
      version
    })),
    uploadedPlugins: [],
    source: {
      mode: 'snapshot',
      snapshotZip: null
    },
    wpConfig: {
      dbName: '',
      dbUser: '',
      dbPassword: '',
      dbHost: '',
      dbPrefix: '',
      wpHome: settings?.url || '',
      wpSiteurl: settings?.url || ''
    },
    branding: {
      backendBrandName: settings?.title || '',
      backendFooterText: '',
      frontendSiteTitle: settings?.title || '',
      frontendTagline: settings?.description || '',
      accentColor: '#2F6FED',
      customCss: '',
      backendLoginLogo: null,
      frontendLogo: null
    }
  };

  return {
    liveSite: {
      url: siteUrl,
      wpVersion,
      userDisplayName: userInfo?.name || userInfo?.slug || '',
      pluginCount: pluginBySlug.size
    },
    warnings,
    profile
  };
}

async function applyLiveSiteSettings(body) {
  const siteUrl = normalizeSiteUrl(body.siteUrl);
  const authHeader = buildBasicAuthHeader(body.username, body.appPassword);

  const branding = body.branding && typeof body.branding === 'object' ? body.branding : {};
  const title = String(branding.frontendSiteTitle || '').trim();
  const tagline = String(branding.frontendTagline || '').trim();

  const payload = {};
  if (title) payload.title = title;
  if (tagline) payload.description = tagline;

  if (Object.keys(payload).length === 0) {
    throw createHttpError('Provide frontend site title and/or tagline before applying to live site', 400);
  }

  const result = await fetchJsonWithAuth(joinSiteUrl(siteUrl, '/wp-json/wp/v2/settings'), authHeader, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  return {
    siteUrl,
    applied: {
      title: result?.title || '',
      description: result?.description || ''
    }
  };
}

function generateLiveBrandingPluginPhp() {
  return `<?php
/**
 * Plugin Name: CustomWP Live Branding Helper
 * Description: Provides branding controls and snapshot export for CustomWP.
 * Version: 1.1.0
 */

if (!defined('ABSPATH')) {
  exit;
}

function customwp_live_branding_defaults() {
  return array(
    'backendBrandName' => '',
    'backendFooterText' => '',
    'backendLoginLogoDataUrl' => '',
    'frontendSiteTitle' => '',
    'frontendTagline' => '',
    'frontendLogoUrl' => '',
    'accentColor' => '#2F6FED',
    'customCss' => ''
  );
}

function customwp_live_branding_get_options() {
  $defaults = customwp_live_branding_defaults();
  $options = get_option('customwp_live_branding', array());
  $options = is_array($options) ? $options : array();
  return array_merge($defaults, $options);
}

function customwp_live_branding_sanitize($payload) {
  $accent = isset($payload['accentColor']) ? sanitize_hex_color($payload['accentColor']) : '';
  if (!$accent) {
    $accent = '#2F6FED';
  }
  $data = array(
    'backendBrandName' => isset($payload['backendBrandName']) ? sanitize_text_field($payload['backendBrandName']) : '',
    'backendFooterText' => isset($payload['backendFooterText']) ? sanitize_text_field($payload['backendFooterText']) : '',
    'backendLoginLogoDataUrl' => isset($payload['backendLoginLogoDataUrl']) ? esc_url_raw($payload['backendLoginLogoDataUrl']) : '',
    'frontendSiteTitle' => isset($payload['frontendSiteTitle']) ? sanitize_text_field($payload['frontendSiteTitle']) : '',
    'frontendTagline' => isset($payload['frontendTagline']) ? sanitize_text_field($payload['frontendTagline']) : '',
    'frontendLogoUrl' => isset($payload['frontendLogoUrl']) ? esc_url_raw($payload['frontendLogoUrl']) : '',
    'accentColor' => $accent,
    'customCss' => isset($payload['customCss']) ? wp_strip_all_tags($payload['customCss']) : ''
  );
  return array_merge(customwp_live_branding_defaults(), $data);
}

function customwp_live_branding_set_options($payload) {
  $data = customwp_live_branding_sanitize($payload);
  update_option('customwp_live_branding', $data, false);
  return $data;
}

add_action('rest_api_init', function () {
  register_rest_route('customwp/v1', '/branding', array(
    array(
      'methods' => 'GET',
      'permission_callback' => function () {
        return current_user_can('manage_options');
      },
      'callback' => function () {
        return rest_ensure_response(customwp_live_branding_get_options());
      }
    ),
    array(
      'methods' => 'POST',
      'permission_callback' => function () {
        return current_user_can('manage_options');
      },
      'callback' => function ($request) {
        $payload = $request->get_json_params();
        if (!is_array($payload)) {
          $payload = array();
        }
        $data = customwp_live_branding_set_options($payload);
        return rest_ensure_response($data);
      }
    )
  ));
});

function customwp_live_branding_value($key, $default = '') {
  $options = customwp_live_branding_get_options();
  return isset($options[$key]) && $options[$key] !== '' ? $options[$key] : $default;
}

function customwp_live_branding_render_settings_page() {
  if (!current_user_can('manage_options')) {
    return;
  }

  $options = customwp_live_branding_get_options();
  $snapshot_url = add_query_arg('_wpnonce', wp_create_nonce('wp_rest'), rest_url('customwp/v1/snapshot'));
  ?>
  <div class="wrap">
    <h1>CustomWP Branding</h1>
    <form method="post" action="options.php">
      <?php settings_fields('customwp_live_branding'); ?>
      <table class="form-table" role="presentation">
        <tr>
          <th scope="row"><label for="customwp_backendBrandName">Admin bar brand name</label></th>
          <td><input name="customwp_live_branding[backendBrandName]" id="customwp_backendBrandName" type="text" class="regular-text" value="<?php echo esc_attr($options['backendBrandName']); ?>" /></td>
        </tr>
        <tr>
          <th scope="row"><label for="customwp_backendFooterText">Admin footer text</label></th>
          <td><input name="customwp_live_branding[backendFooterText]" id="customwp_backendFooterText" type="text" class="regular-text" value="<?php echo esc_attr($options['backendFooterText']); ?>" /></td>
        </tr>
        <tr>
          <th scope="row"><label for="customwp_backendLoginLogoDataUrl">Login logo</label></th>
          <td>
            <input name="customwp_live_branding[backendLoginLogoDataUrl]" id="customwp_backendLoginLogoDataUrl" type="text" class="regular-text customwp-media-target" value="<?php echo esc_attr($options['backendLoginLogoDataUrl']); ?>" />
            <button class="button customwp-media-select" data-target="customwp_backendLoginLogoDataUrl" type="button">Choose</button>
            <p class="description">Pick an image from the media library or paste a URL.</p>
          </td>
        </tr>
        <tr>
          <th scope="row"><label for="customwp_frontendSiteTitle">Frontend site title override</label></th>
          <td><input name="customwp_live_branding[frontendSiteTitle]" id="customwp_frontendSiteTitle" type="text" class="regular-text" value="<?php echo esc_attr($options['frontendSiteTitle']); ?>" /></td>
        </tr>
        <tr>
          <th scope="row"><label for="customwp_frontendTagline">Frontend tagline</label></th>
          <td><input name="customwp_live_branding[frontendTagline]" id="customwp_frontendTagline" type="text" class="regular-text" value="<?php echo esc_attr($options['frontendTagline']); ?>" /></td>
        </tr>
        <tr>
          <th scope="row"><label for="customwp_frontendLogoUrl">Frontend logo</label></th>
          <td>
            <input name="customwp_live_branding[frontendLogoUrl]" id="customwp_frontendLogoUrl" type="text" class="regular-text customwp-media-target" value="<?php echo esc_attr($options['frontendLogoUrl']); ?>" />
            <button class="button customwp-media-select" data-target="customwp_frontendLogoUrl" type="button">Choose</button>
            <p class="description">Used in the frontend header bar injected by the plugin.</p>
          </td>
        </tr>
        <tr>
          <th scope="row"><label for="customwp_accentColor">Accent color</label></th>
          <td><input name="customwp_live_branding[accentColor]" id="customwp_accentColor" type="text" class="regular-text" value="<?php echo esc_attr($options['accentColor']); ?>" /></td>
        </tr>
        <tr>
          <th scope="row"><label for="customwp_customCss">Custom CSS</label></th>
          <td><textarea name="customwp_live_branding[customCss]" id="customwp_customCss" class="large-text" rows="6"><?php echo esc_textarea($options['customCss']); ?></textarea></td>
        </tr>
      </table>
      <?php submit_button('Save Branding'); ?>
    </form>

    <hr />
    <h2>Snapshot Export</h2>
    <p>Download a ZIP of the current WordPress filesystem for CustomWP Builder.</p>
    <a class="button button-primary" href="<?php echo esc_url($snapshot_url); ?>">Download Snapshot ZIP</a>
  </div>
  <?php
}

add_action('admin_menu', function () {
  add_options_page('CustomWP Branding', 'CustomWP Branding', 'manage_options', 'customwp-branding', 'customwp_live_branding_render_settings_page');
});

add_action('admin_init', function () {
  register_setting('customwp_live_branding', 'customwp_live_branding', 'customwp_live_branding_sanitize');
});

add_action('admin_enqueue_scripts', function ($hook) {
  if ($hook !== 'settings_page_customwp-branding') {
    return;
  }
  wp_enqueue_media();
  wp_enqueue_script('jquery');
  $script = "(function(){\n"
    . "function bindMedia(button){\n"
    . "  button.addEventListener('click', function(){\n"
    . "    var targetId = button.getAttribute('data-target');\n"
    . "    var target = document.getElementById(targetId);\n"
    . "    if (!target) return;\n"
    . "    var frame = wp.media({ title: 'Select image', button: { text: 'Use image' }, multiple: false });\n"
    . "    frame.on('select', function(){\n"
    . "      var attachment = frame.state().get('selection').first().toJSON();\n"
    . "      target.value = attachment.url || '';\n"
    . "    });\n"
    . "    frame.open();\n"
    . "  });\n"
    . "}\n"
    . "document.querySelectorAll('.customwp-media-select').forEach(bindMedia);\n"
    . "})();";
  wp_add_inline_script('jquery', $script);
});

add_action('login_enqueue_scripts', function () {
  $logo = customwp_live_branding_value('backendLoginLogoDataUrl');
  if (!$logo) {
    return;
  }

  echo '<style>#login h1 a{background-image:url(' . esc_url($logo) . ');background-size:contain;width:100%;}</style>';
});

add_action('admin_bar_menu', function ($wp_admin_bar) {
  $brand = customwp_live_branding_value('backendBrandName');
  if (!$brand) {
    return;
  }

  $wp_admin_bar->remove_node('wp-logo');
  $wp_admin_bar->add_node(array(
    'id'    => 'customwp-brand',
    'title' => esc_html($brand),
    'href'  => admin_url()
  ));
}, 99);

add_filter('admin_footer_text', function ($text) {
  $footer = customwp_live_branding_value('backendFooterText');
  return $footer ? esc_html($footer) : $text;
});

add_filter('pre_option_blogname', function ($value) {
  $title = customwp_live_branding_value('frontendSiteTitle');
  return $title ? $title : $value;
});

add_filter('pre_option_blogdescription', function ($value) {
  $tagline = customwp_live_branding_value('frontendTagline');
  return $tagline ? $tagline : $value;
});

add_action('wp_head', function () {
  $accent = customwp_live_branding_value('accentColor', '#2F6FED');
  $css = customwp_live_branding_value('customCss');
  echo '<style>:root{--customwp-accent:' . esc_attr($accent) . ';}</style>';

  if ($css) {
    echo '<style id="customwp-custom-css">' . wp_strip_all_tags($css) . '</style>';
  }
});

add_action('wp_body_open', function () {
  $logo = customwp_live_branding_value('frontendLogoUrl');
  $tagline = customwp_live_branding_value('frontendTagline');

  if (!$logo && !$tagline) {
    return;
  }

  echo '<div style="padding:12px 16px;border-bottom:1px solid rgba(0,0,0,.08);display:flex;gap:12px;align-items:center;background:#fff;">';
  if ($logo) {
    echo '<img src="' . esc_url($logo) . '" alt="logo" style="max-height:42px;width:auto;" />';
  }
  if ($tagline) {
    echo '<span style="font-size:14px;opacity:.8;">' . esc_html($tagline) . '</span>';
  }
  echo '</div>';
}, 2);

function customwp_snapshot_should_skip($relative) {
  $relative = str_replace('\\\\', '/', $relative);
  $skip_prefixes = array(
    '.git/',
    'node_modules/',
    'wp-content/cache/',
    'wp-content/uploads/cache/',
    'wp-content/uploads/customwp/'
  );

  foreach ($skip_prefixes as $prefix) {
    if (strpos($relative, $prefix) === 0) {
      return true;
    }
  }

  return false;
}

function customwp_snapshot_build_zip() {
  if (!class_exists('ZipArchive')) {
    return new WP_Error('customwp_zip_missing', 'ZipArchive is not available on this server.');
  }

  $root = realpath(ABSPATH);
  if (!$root) {
    return new WP_Error('customwp_root_missing', 'Could not resolve WordPress root.');
  }

  $uploads = wp_upload_dir();
  if (empty($uploads['basedir'])) {
    return new WP_Error('customwp_uploads_missing', 'Uploads directory is not available.');
  }

  $snapshot_dir = trailingslashit($uploads['basedir']) . 'customwp';
  if (!file_exists($snapshot_dir)) {
    wp_mkdir_p($snapshot_dir);
  }

  $zip_path = trailingslashit($snapshot_dir) . 'customwp-snapshot-' . gmdate('Ymd-His') . '.zip';
  $zip = new ZipArchive();
  if ($zip->open($zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
    return new WP_Error('customwp_zip_open_failed', 'Unable to create snapshot ZIP.');
  }

  $iterator = new RecursiveIteratorIterator(
    new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
    RecursiveIteratorIterator::SELF_FIRST
  );

  foreach ($iterator as $file) {
    $file_path = $file->getPathname();
    $relative = ltrim(str_replace($root, '', $file_path), DIRECTORY_SEPARATOR);
    $relative = str_replace('\\\\', '/', $relative);

    if ($relative === '' || customwp_snapshot_should_skip($relative)) {
      continue;
    }

    if ($file->isDir()) {
      $zip->addEmptyDir($relative);
    } else {
      $zip->addFile($file_path, $relative);
    }
  }

  $zip->close();
  return $zip_path;
}

add_action('rest_api_init', function () {
  register_rest_route('customwp/v1', '/snapshot', array(
    'methods' => 'GET',
    'permission_callback' => function () {
      return current_user_can('manage_options');
    },
    'callback' => function () {
      $zip_path = customwp_snapshot_build_zip();
      if (is_wp_error($zip_path)) {
        return $zip_path;
      }
      if (!file_exists($zip_path)) {
        return new WP_Error('customwp_snapshot_missing', 'Snapshot ZIP not found.');
      }

      $filename = basename($zip_path);
      nocache_headers();
      header('Content-Type: application/zip');
      header('Content-Disposition: attachment; filename="' . $filename . '"');
      header('Content-Length: ' . filesize($zip_path));
      readfile($zip_path);
      unlink($zip_path);
      exit;
    }
  ));
});
`;
}

async function buildLiveBrandingPluginZip() {
  const workRoot = path.join(TMP_DIR, `live-branding-${randomUUID()}`);
  const pluginRoot = path.join(workRoot, 'customwp-live-branding');
  const pluginPath = path.join(pluginRoot, 'customwp-live-branding.php');
  const zipPath = path.join(workRoot, 'customwp-live-branding.zip');

  await fsp.mkdir(pluginRoot, { recursive: true });
  await fsp.writeFile(pluginPath, generateLiveBrandingPluginPhp(), 'utf-8');
  await runCommand('zip', ['-qr', zipPath, 'customwp-live-branding'], { cwd: workRoot });

  return { zipPath, workRoot };
}

async function applyBackendBrandingToLiveSite(body) {
  const siteUrl = normalizeSiteUrl(body.siteUrl);
  const authHeader = buildBasicAuthHeader(body.username, body.appPassword);
  const branding = body.branding && typeof body.branding === 'object' ? body.branding : {};

  const payload = {
    backendBrandName: String(branding.backendBrandName || '').trim(),
    backendFooterText: String(branding.backendFooterText || '').trim(),
    backendLoginLogoDataUrl: branding.backendLoginLogo ? toDataUrl(branding.backendLoginLogo) : ''
  };

  try {
    const result = await fetchJsonWithAuth(joinSiteUrl(siteUrl, '/wp-json/customwp/v1/branding'), authHeader, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    return {
      siteUrl,
      applied: {
        backendBrandName: result?.backendBrandName || payload.backendBrandName,
        backendFooterText: result?.backendFooterText || payload.backendFooterText,
        backendLoginLogo: Boolean(result?.backendLoginLogoDataUrl || payload.backendLoginLogoDataUrl)
      }
    };
  } catch (error) {
    if (error.statusCode === 404) {
      throw createHttpError(
        'CustomWP Live Branding Helper is not installed on the live site. Download it from /api/live/branding-plugin and install it first.',
        404
      );
    }
    throw error;
  }
}

function parseFilenameFromContentDisposition(header) {
  if (!header) return null;
  const match = /filename="?(?<name>[^";]+)"?/i.exec(header);
  return match?.groups?.name || null;
}

async function downloadLiveSnapshotZip(body) {
  const siteUrl = normalizeSiteUrl(body.siteUrl);
  const authHeader = buildBasicAuthHeader(body.username, body.appPassword);
  const response = await fetch(joinSiteUrl(siteUrl, '/wp-json/customwp/v1/snapshot'), {
    headers: {
      Authorization: authHeader
    }
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw createHttpError(
        'CustomWP Live Branding Helper is not installed on the live site. Download it from /api/live/branding-plugin and install it first.',
        404
      );
    }
    throw createHttpError(`Snapshot download failed (${response.status}).`, response.status);
  }

  const arrayBuffer = await response.arrayBuffer();
  const filename = parseFilenameFromContentDisposition(response.headers.get('content-disposition'))
    || `customwp-snapshot-${Date.now()}.zip`;

  return {
    siteUrl,
    snapshotZip: {
      filename,
      dataBase64: Buffer.from(arrayBuffer).toString('base64')
    },
    sizeBytes: arrayBuffer.byteLength
  };
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) for ${url}`);
  }
  if (!response.body) {
    throw new Error(`Download body missing for ${url}`);
  }

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(outputPath));
}

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: 'pipe'
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

function buildPluginInfoUrl(action, params = {}) {
  const search = new URLSearchParams({ action });
  for (const [key, value] of Object.entries(params)) {
    search.set(key, value);
  }
  return `https://api.wordpress.org/plugins/info/1.2/?${search.toString()}`;
}

async function getWordPressVersions() {
  const stable = await fetchJson('https://api.wordpress.org/core/stable-check/1.0/');
  const versions = Object.keys(stable)
    .filter((key) => isVersionLike(key))
    .sort((a, b) => compareVersions(b, a));

  const withLatest = versions.includes('latest') ? versions : ['latest', ...versions];
  return withLatest.slice(0, 150);
}

function resolveCompatibility(plugin, wpVersion) {
  const requires = plugin.requires || '';
  const tested = plugin.tested || '';

  if (!wpVersion || wpVersion === 'latest' || !isVersionLike(wpVersion)) {
    return {
      status: 'unknown',
      note: 'Compatibility not checked for latest core.'
    };
  }

  if (requires && isVersionLike(requires) && compareVersions(wpVersion, requires) < 0) {
    return {
      status: 'incompatible',
      note: `Requires WordPress ${requires}+`
    };
  }

  if (tested && isVersionLike(tested) && compareVersions(wpVersion, tested) > 0) {
    return {
      status: 'untested',
      note: `Tested up to WordPress ${tested}`
    };
  }

  return {
    status: 'compatible',
    note: 'Looks compatible with selected core version.'
  };
}

async function resolvePluginForInstall(slug, wpVersion, preferredVersion = null) {
  const cleanSlug = normalizeSlug(slug);
  if (!cleanSlug) throw new Error('Invalid plugin slug');

  const infoUrl = buildPluginInfoUrl('plugin_information', {
    'request[slug]': cleanSlug,
    'request[fields][versions]': '1'
  });
  const info = await fetchJson(infoUrl);
  const versions = info.versions || {};

  let targetVersion = info.version;
  let reason = 'Latest plugin version selected.';

  if (preferredVersion && versions[preferredVersion]) {
    targetVersion = preferredVersion;
    reason = `Pinned to imported plugin version ${preferredVersion}.`;
  }

  if (
    !preferredVersion &&
    wpVersion &&
    isVersionLike(wpVersion) &&
    info.requires &&
    isVersionLike(info.requires)
  ) {
    if (compareVersions(wpVersion, info.requires) < 0) {
      const candidates = Object.keys(versions)
        .filter((v) => isVersionLike(v))
        .sort((a, b) => compareVersions(b, a));

      const fallback = candidates.find((v) => compareVersions(v, info.version) < 0);
      if (fallback) {
        targetVersion = fallback;
        reason = 'Selected older plugin version as a fallback for older WordPress core.';
      }
    }
  }

  const downloadUrl = versions[targetVersion] || info.download_link;
  if (!downloadUrl) {
    throw new Error(`No download URL available for plugin ${cleanSlug}`);
  }

  return {
    slug: cleanSlug,
    name: info.name || cleanSlug,
    targetVersion,
    downloadUrl,
    requires: info.requires || null,
    tested: info.tested || null,
    reason
  };
}

function safeFilename(name, fallback = 'file.bin') {
  const clean = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '');
  return clean || fallback;
}

async function saveBase64File(fileObj, targetDir, fallbackName) {
  if (!fileObj || !fileObj.dataBase64) return null;

  const filename = safeFilename(fileObj.filename, fallbackName);
  const outputPath = path.join(targetDir, filename);

  const buffer = Buffer.from(fileObj.dataBase64, 'base64');
  await fsp.mkdir(targetDir, { recursive: true });
  await fsp.writeFile(outputPath, buffer);

  return {
    filename,
    outputPath
  };
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findWordPressRoot(searchRoot, maxDepth = 5) {
  const queue = [{ dir: searchRoot, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    const currentDir = current.dir;
    const depth = current.depth;

    const hasWpContent = await pathExists(path.join(currentDir, 'wp-content'));
    const hasWpIncludesVersion = await pathExists(path.join(currentDir, 'wp-includes', 'version.php'));
    const hasConfig = await pathExists(path.join(currentDir, 'wp-config.php'))
      || await pathExists(path.join(currentDir, 'wp-config-sample.php'));

    if (hasWpContent && hasWpIncludesVersion && hasConfig) {
      return currentDir;
    }

    if (depth >= maxDepth) {
      continue;
    }

    let entries = [];
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      queue.push({ dir: path.join(currentDir, entry.name), depth: depth + 1 });
    }
  }

  return null;
}

function phpSingleQuoted(value) {
  return `'${String(value || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function replacePhpDefine(content, constantName, nextValue) {
  if (!nextValue) return content;
  const pattern = new RegExp(
    `define\\(\\s*['"]${constantName}['"]\\s*,\\s*([\\s\\S]*?)\\);`,
    'm'
  );
  if (pattern.test(content)) {
    return content.replace(pattern, `define('${constantName}', ${phpSingleQuoted(nextValue)});`);
  }
  return `${content}\ndefine('${constantName}', ${phpSingleQuoted(nextValue)});\n`;
}

function replaceTablePrefix(content, prefix) {
  if (!prefix) return content;
  const pattern = /\$table_prefix\s*=\s*['"][^'"]*['"]\s*;/m;
  if (pattern.test(content)) {
    return content.replace(pattern, `$table_prefix = ${phpSingleQuoted(prefix)};`);
  }
  return `${content}\n$table_prefix = ${phpSingleQuoted(prefix)};\n`;
}

async function applyWpConfigOverrides(wpRoot, config, log) {
  const wpConfigPath = path.join(wpRoot, 'wp-config.php');
  const samplePath = path.join(wpRoot, 'wp-config-sample.php');

  if (!(await pathExists(wpConfigPath))) {
    if (await pathExists(samplePath)) {
      await fsp.copyFile(samplePath, wpConfigPath);
      log('Created wp-config.php from wp-config-sample.php.');
    } else {
      throw createHttpError('Could not find wp-config.php or wp-config-sample.php in snapshot/build root');
    }
  }

  let content = await fsp.readFile(wpConfigPath, 'utf-8');

  content = replacePhpDefine(content, 'DB_NAME', config.dbName);
  content = replacePhpDefine(content, 'DB_USER', config.dbUser);
  content = replacePhpDefine(content, 'DB_PASSWORD', config.dbPassword);
  content = replacePhpDefine(content, 'DB_HOST', config.dbHost);
  content = replacePhpDefine(content, 'WP_HOME', config.wpHome);
  content = replacePhpDefine(content, 'WP_SITEURL', config.wpSiteurl);
  content = replaceTablePrefix(content, config.dbPrefix);

  await fsp.writeFile(wpConfigPath, content, 'utf-8');
}

async function detectWordPressVersionFromFiles(wpRoot) {
  const versionPath = path.join(wpRoot, 'wp-includes', 'version.php');
  if (!(await pathExists(versionPath))) return '';

  try {
    const raw = await fsp.readFile(versionPath, 'utf-8');
    const match = raw.match(/\$wp_version\s*=\s*'([^']+)'/);
    return match ? String(match[1]).trim() : '';
  } catch {
    return '';
  }
}

async function prepareWordPressBase(spec, workRoot, log) {
  if (spec.source.mode === 'snapshot') {
    if (!spec.source.snapshotZip?.dataBase64) {
      throw createHttpError('Snapshot mode requires a site snapshot ZIP upload.', 400);
    }

    const snapshotName = safeFilename(spec.source.snapshotZip.filename, 'site-snapshot.zip');
    const snapshotZipPath = path.join(workRoot, snapshotName);
    const snapshotExtractRoot = path.join(workRoot, 'snapshot-extract');

    log(`Using snapshot base (${snapshotName})...`);
    await fsp.writeFile(snapshotZipPath, Buffer.from(spec.source.snapshotZip.dataBase64, 'base64'));
    await fsp.mkdir(snapshotExtractRoot, { recursive: true });
    await runCommand('unzip', ['-q', '-o', snapshotZipPath, '-d', snapshotExtractRoot]);

    const wpRoot = await findWordPressRoot(snapshotExtractRoot);
    if (!wpRoot) {
      throw createHttpError(
        'Could not find a WordPress root inside the snapshot ZIP (expected wp-content and wp-includes/version.php).',
        400
      );
    }

    const detectedVersion = await detectWordPressVersionFromFiles(wpRoot);
    return {
      wpRoot,
      coreVersion: detectedVersion || spec.wpVersion || 'snapshot',
      mode: 'snapshot'
    };
  }

  const coreVersion = spec.wpVersion === 'latest' ? 'latest' : spec.wpVersion;
  const coreUrl = coreVersion === 'latest'
    ? 'https://wordpress.org/latest.zip'
    : `https://wordpress.org/wordpress-${coreVersion}.zip`;
  const coreZip = path.join(workRoot, 'wordpress-core.zip');

  log(`Downloading WordPress core (${coreVersion})...`);
  await downloadFile(coreUrl, coreZip);

  log('Extracting WordPress core...');
  await runCommand('unzip', ['-q', '-o', coreZip, '-d', workRoot]);

  return {
    wpRoot: path.join(workRoot, 'wordpress'),
    coreVersion,
    mode: 'blueprint'
  };
}

function generateBrandingPhp() {
  return `<?php
/**
 * Plugin Name: CustomWP Branding (MU)
 * Description: Applies generated backend and frontend branding.
 */

if (!defined('ABSPATH')) {
  exit;
}

function customwp_branding_config() {
  static $config = null;
  if ($config !== null) {
    return $config;
  }

  $path = WP_CONTENT_DIR . '/customwp/branding.json';
  if (!file_exists($path)) {
    $config = array();
    return $config;
  }

  $raw = file_get_contents($path);
  $decoded = json_decode($raw, true);
  $config = is_array($decoded) ? $decoded : array();
  return $config;
}

function customwp_branding_value($key, $default = '') {
  $config = customwp_branding_config();
  return isset($config[$key]) && $config[$key] !== '' ? $config[$key] : $default;
}

add_action('login_enqueue_scripts', function () {
  $logo = customwp_branding_value('backendLoginLogoPath');
  if (!$logo) {
    return;
  }

  echo '<style>#login h1 a{background-image:url(' . esc_url($logo) . ');background-size:contain;width:100%;}</style>';
});

add_action('admin_bar_menu', function ($wp_admin_bar) {
  $brand = customwp_branding_value('backendBrandName');
  if (!$brand) {
    return;
  }

  $wp_admin_bar->remove_node('wp-logo');
  $wp_admin_bar->add_node(array(
    'id'    => 'customwp-brand',
    'title' => esc_html($brand),
    'href'  => admin_url()
  ));
}, 99);

add_filter('admin_footer_text', function ($text) {
  $footer = customwp_branding_value('backendFooterText');
  return $footer ? esc_html($footer) : $text;
});

add_filter('pre_option_blogname', function ($value) {
  $title = customwp_branding_value('frontendSiteTitle');
  return $title ? $title : $value;
});

add_filter('pre_option_blogdescription', function ($value) {
  $tagline = customwp_branding_value('frontendTagline');
  return $tagline ? $tagline : $value;
});

add_action('wp_head', function () {
  $accent = customwp_branding_value('accentColor', '#2F6FED');
  $css = customwp_branding_value('customCss');
  echo '<style>:root{--customwp-accent:' . esc_attr($accent) . ';}</style>';

  if ($css) {
    echo '<style id="customwp-custom-css">' . wp_strip_all_tags($css) . '</style>';
  }
});

add_action('wp_body_open', function () {
  $logo = customwp_branding_value('frontendLogoPath');
  $tagline = customwp_branding_value('frontendTagline');

  if (!$logo && !$tagline) {
    return;
  }

  echo '<div style="padding:12px 16px;border-bottom:1px solid rgba(0,0,0,.08);display:flex;gap:12px;align-items:center;background:#fff;">';
  if ($logo) {
    echo '<img src="' . esc_url($logo) . '" alt="logo" style="max-height:42px;width:auto;" />';
  }
  if ($tagline) {
    echo '<span style="font-size:14px;opacity:.8;">' . esc_html($tagline) . '</span>';
  }
  echo '</div>';
}, 2);
`;
}

function normalizeBuildPayload(payload) {
  const branding = payload.branding || {};
  const source = payload.source || {};
  const wpConfig = payload.wpConfig || {};
  const mode = String(source.mode || '').trim().toLowerCase() === 'blueprint' ? 'blueprint' : 'snapshot';

  return {
    wpVersion: payload.wpVersion || 'latest',
    plugins: Array.isArray(payload.plugins)
      ? payload.plugins.map((plugin) => ({
          slug: normalizeSlug(plugin?.slug || plugin),
          version: isVersionLike(plugin?.version || '') ? String(plugin.version) : ''
        })).filter((plugin) => plugin.slug)
      : [],
    uploadedPlugins: Array.isArray(payload.uploadedPlugins) ? payload.uploadedPlugins : [],
    source: {
      mode,
      snapshotZip: source.snapshotZip || null
    },
    wpConfig: {
      dbName: String(wpConfig.dbName || '').trim(),
      dbUser: String(wpConfig.dbUser || '').trim(),
      dbPassword: String(wpConfig.dbPassword || ''),
      dbHost: String(wpConfig.dbHost || '').trim(),
      dbPrefix: String(wpConfig.dbPrefix || '').trim(),
      wpHome: String(wpConfig.wpHome || '').trim(),
      wpSiteurl: String(wpConfig.wpSiteurl || '').trim()
    },
    branding: {
      backendBrandName: String(branding.backendBrandName || '').trim(),
      backendFooterText: String(branding.backendFooterText || '').trim(),
      frontendSiteTitle: String(branding.frontendSiteTitle || '').trim(),
      frontendTagline: String(branding.frontendTagline || '').trim(),
      accentColor: String(branding.accentColor || '#2F6FED').trim() || '#2F6FED',
      customCss: String(branding.customCss || ''),
      backendLoginLogo: branding.backendLoginLogo || null,
      frontendLogo: branding.frontendLogo || null
    }
  };
}

async function runBuildJob(job, payload) {
  const buildId = job.id;
  const spec = normalizeBuildPayload(payload);
  const workRoot = path.join(TMP_DIR, `build-${buildId}`);

  function log(message) {
    job.logs.push(message);
  }

  try {
    log('Preparing build workspace...');
    await fsp.rm(workRoot, { recursive: true, force: true });
    await fsp.mkdir(workRoot, { recursive: true });

    const base = await prepareWordPressBase(spec, workRoot, log);
    const wpRoot = base.wpRoot;
    const coreVersion = base.coreVersion;

    const pluginDir = path.join(wpRoot, 'wp-content', 'plugins');
    const customRoot = path.join(wpRoot, 'wp-content', 'customwp');
    const customAssets = path.join(customRoot, 'assets');
    const muPluginDir = path.join(wpRoot, 'wp-content', 'mu-plugins');

    await fsp.mkdir(pluginDir, { recursive: true });
    await fsp.mkdir(customAssets, { recursive: true });
    await fsp.mkdir(muPluginDir, { recursive: true });

    const installedPlugins = [];

    for (const plugin of spec.plugins) {
      const slug = normalizeSlug(plugin.slug || plugin);
      if (!slug) continue;
      const preferredVersion = String(plugin.version || '').trim();

      if (spec.source.mode === 'snapshot' && await pathExists(path.join(pluginDir, slug))) {
        log(`Keeping plugin ${slug} from snapshot.`);
        installedPlugins.push({
          source: 'snapshot',
          slug,
          version: preferredVersion || null,
          reason: 'Already present in snapshot'
        });
        continue;
      }

      log(`Resolving plugin ${slug}...`);
      const resolved = await resolvePluginForInstall(
        slug,
        coreVersion === 'latest' ? null : coreVersion,
        preferredVersion
      );

      const zipPath = path.join(workRoot, `${slug}-${resolved.targetVersion}.zip`);
      log(`Downloading ${resolved.name} (${resolved.targetVersion})...`);
      await downloadFile(resolved.downloadUrl, zipPath);

      log(`Installing plugin ${slug}...`);
      await runCommand('unzip', ['-q', '-o', zipPath, '-d', pluginDir]);

      installedPlugins.push({
        source: 'wordpress.org',
        slug,
        name: resolved.name,
        version: resolved.targetVersion,
        requires: resolved.requires,
        tested: resolved.tested,
        reason: resolved.reason
      });
    }

    for (const zip of spec.uploadedPlugins) {
      if (!zip || !zip.dataBase64) continue;

      const filename = safeFilename(zip.filename, 'custom-plugin.zip');
      const zipPath = path.join(workRoot, filename);
      log(`Installing uploaded plugin ${filename}...`);

      await fsp.writeFile(zipPath, Buffer.from(zip.dataBase64, 'base64'));
      await runCommand('unzip', ['-q', '-o', zipPath, '-d', pluginDir]);

      installedPlugins.push({
        source: 'upload',
        filename
      });
    }

    if (
      spec.wpConfig.dbName ||
      spec.wpConfig.dbUser ||
      spec.wpConfig.dbPassword ||
      spec.wpConfig.dbHost ||
      spec.wpConfig.dbPrefix ||
      spec.wpConfig.wpHome ||
      spec.wpConfig.wpSiteurl
    ) {
      log('Applying wp-config.php overrides...');
      await applyWpConfigOverrides(wpRoot, spec.wpConfig, log);
    }

    const backendLogoFile = await saveBase64File(
      spec.branding.backendLoginLogo,
      customAssets,
      'backend-logo.png'
    );

    const frontendLogoFile = await saveBase64File(
      spec.branding.frontendLogo,
      customAssets,
      'frontend-logo.png'
    );

    const brandingConfig = {
      backendBrandName: spec.branding.backendBrandName,
      backendFooterText: spec.branding.backendFooterText,
      frontendSiteTitle: spec.branding.frontendSiteTitle,
      frontendTagline: spec.branding.frontendTagline,
      accentColor: spec.branding.accentColor,
      customCss: spec.branding.customCss,
      backendLoginLogoPath: backendLogoFile ? `/wp-content/customwp/assets/${backendLogoFile.filename}` : '',
      frontendLogoPath: frontendLogoFile ? `/wp-content/customwp/assets/${frontendLogoFile.filename}` : ''
    };

    log('Writing branding configuration...');
    await fsp.writeFile(
      path.join(customRoot, 'branding.json'),
      JSON.stringify(brandingConfig, null, 2),
      'utf-8'
    );

    await fsp.writeFile(
      path.join(muPluginDir, 'customwp-branding.php'),
      generateBrandingPhp(),
      'utf-8'
    );

    const manifest = {
      buildId,
      generatedAt: new Date().toISOString(),
      wordpressVersion: coreVersion,
      sourceMode: spec.source.mode,
      pluginCount: installedPlugins.length,
      installedPlugins,
      wpConfig: {
        dbName: spec.wpConfig.dbName,
        dbUser: spec.wpConfig.dbUser,
        dbHost: spec.wpConfig.dbHost,
        dbPrefix: spec.wpConfig.dbPrefix,
        wpHome: spec.wpConfig.wpHome,
        wpSiteurl: spec.wpConfig.wpSiteurl
      },
      branding: {
        backendBrandName: brandingConfig.backendBrandName,
        frontendSiteTitle: brandingConfig.frontendSiteTitle,
        frontendTagline: brandingConfig.frontendTagline,
        accentColor: brandingConfig.accentColor
      }
    };

    await fsp.writeFile(
      path.join(wpRoot, 'customwp-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    const outputZipName = `customwp-${buildId}.zip`;
    const outputZipPath = path.join(BUILD_DIR, outputZipName);
    const zipRootName = 'wordpress';
    let zipCwd = path.dirname(wpRoot);
    let zipTarget = path.basename(wpRoot);

    if (zipTarget !== zipRootName) {
      const packageRoot = path.join(workRoot, 'package-root');
      const normalizedRoot = path.join(packageRoot, zipRootName);
      await fsp.mkdir(packageRoot, { recursive: true });
      await fsp.cp(wpRoot, normalizedRoot, { recursive: true });
      zipCwd = packageRoot;
      zipTarget = zipRootName;
    }

    log('Compressing build artifact...');
    await runCommand('zip', ['-qr', outputZipPath, zipTarget], { cwd: zipCwd });

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.artifact = {
      filename: outputZipName,
      path: outputZipPath,
      sizeBytes: (await fsp.stat(outputZipPath)).size
    };

    log('Build completed successfully.');
  } finally {
    await fsp.rm(workRoot, { recursive: true, force: true });
  }
}

async function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const absolute = path.join(PUBLIC_DIR, safePath);
  const normalized = path.normalize(absolute);

  if (!normalized.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = await fsp.stat(normalized);
    if (!stat.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const ext = path.extname(normalized).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stat.size });
    fs.createReadStream(normalized).pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

function getJobResponse(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    completedAt: job.completedAt || null,
    error: job.error || null,
    logs: job.logs,
    artifact: job.artifact
      ? {
          filename: job.artifact.filename,
          sizeBytes: job.artifact.sizeBytes,
          downloadUrl: `/api/build/${job.id}/download`
        }
      : null
  };
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;

  if (req.method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/wordpress/versions') {
    const versions = await getWordPressVersions();
    sendJson(res, 200, { versions });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/plugins/search') {
    const query = String(searchParams.get('q') || '').trim();
    const page = Math.max(parseInt(searchParams.get('page') || '1', 10), 1);
    const wpVersion = String(searchParams.get('wpVersion') || '').trim();

    if (!query) {
      sendJson(res, 200, { plugins: [], page, total: 0 });
      return;
    }

    const searchUrl = buildPluginInfoUrl('query_plugins', {
      'request[search]': query,
      'request[page]': String(page),
      'request[per_page]': '24',
      'request[fields][versions]': '0'
    });

    const result = await fetchJson(searchUrl);
    const plugins = (result.plugins || []).map((plugin) => {
      const compatibility = resolveCompatibility(plugin, wpVersion);
      return {
        slug: plugin.slug,
        name: plugin.name,
        version: plugin.version,
        requires: plugin.requires,
        tested: plugin.tested,
        shortDescription: plugin.short_description,
        author: plugin.author,
        compatibility
      };
    });

    sendJson(res, 200, {
      plugins,
      page,
      total: result.info?.results || plugins.length,
      pages: result.info?.pages || 1
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/plugins/resolve') {
    const body = await readJsonBody(req);
    if (!body.slug) {
      sendJson(res, 400, { error: 'Missing plugin slug' });
      return;
    }

    const resolved = await resolvePluginForInstall(
      body.slug,
      body.wpVersion || null,
      body.preferredVersion || null
    );
    sendJson(res, 200, { plugin: resolved });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/live/import') {
    const body = await readJsonBody(req);
    const imported = await importLiveSiteProfile(body);
    sendJson(res, 200, imported);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/live/apply') {
    const body = await readJsonBody(req);
    const result = await applyLiveSiteSettings(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/live/apply-backend-branding') {
    const body = await readJsonBody(req);
    const result = await applyBackendBrandingToLiveSite(body);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/live/snapshot') {
    const body = await readJsonBody(req);
    const snapshot = await downloadLiveSnapshotZip(body);
    sendJson(res, 200, snapshot);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/live/branding-plugin') {
    const build = await buildLiveBrandingPluginZip();
    try {
      const stat = await fsp.stat(build.zipPath);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="customwp-live-branding.zip"'
      });
      fs.createReadStream(build.zipPath).pipe(res);
    } finally {
      await fsp.rm(build.workRoot, { recursive: true, force: true });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/build') {
    const payload = await readJsonBody(req);
    const id = randomUUID();

    const job = {
      id,
      status: 'running',
      createdAt: new Date().toISOString(),
      completedAt: null,
      artifact: null,
      error: null,
      logs: ['Build job queued.']
    };

    jobs.set(id, job);

    runBuildJob(job, payload).catch((error) => {
      job.status = 'failed';
      job.error = error.message || String(error);
      job.completedAt = new Date().toISOString();
      job.logs.push(`Build failed: ${job.error}`);
    });

    sendJson(res, 202, { id, statusUrl: `/api/build/${id}` });
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/build/')) {
    const parts = pathname.split('/').filter(Boolean);
    const id = parts[2];
    const action = parts[3] || null;

    const job = jobs.get(id);
    if (!job) {
      sendJson(res, 404, { error: 'Build job not found' });
      return;
    }

    if (action === 'download') {
      if (!job.artifact || job.status !== 'completed') {
        sendJson(res, 409, { error: 'Build artifact not available yet' });
        return;
      }

      const stat = await fsp.stat(job.artifact.path);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': stat.size,
        'Content-Disposition': `attachment; filename="${job.artifact.filename}"`
      });
      fs.createReadStream(job.artifact.path).pipe(res);
      return;
    }

    sendJson(res, 200, getJobResponse(job));
    return;
  }

  sendJson(res, 404, { error: 'Route not found' });
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }

    if (req.method === 'GET') {
      await serveStatic(req, res, url.pathname);
      return;
    }

    sendText(res, 405, 'Method not allowed');
  } catch (error) {
    const statusCode = error.statusCode || 500;
    sendJson(res, statusCode, {
      error: error.message || 'Internal server error'
    });
  }
}

ensureDirs()
  .then(() => {
    const server = http.createServer(handler);
    server.listen(PORT, HOST, () => {
      console.log(`CustomWP Builder running on http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Startup failure:', error);
    process.exit(1);
  });
