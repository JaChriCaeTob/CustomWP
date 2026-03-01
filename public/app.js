const state = {
  selectedPlugins: [],
  uploadedPlugins: [],
  backendLoginLogo: null,
  frontendLogo: null,
  activeBuildId: null,
  pollTimer: null
};

const BUNDLES = {
  seo: ['wordpress-seo', 'all-in-one-seo-pack', 'seo-by-rank-math'],
  performance: ['wp-super-cache', 'autoptimize', 'wp-optimize'],
  security: ['wordfence', 'sucuri-scanner', 'wp-2fa']
};

const els = {
  wpVersion: document.getElementById('wp-version'),
  pluginQuery: document.getElementById('plugin-query'),
  searchPlugins: document.getElementById('search-plugins'),
  pluginResults: document.getElementById('plugin-results'),
  selectedPlugins: document.getElementById('selected-plugins'),
  uploadPlugins: document.getElementById('upload-plugins'),
  uploadedPlugins: document.getElementById('uploaded-plugins'),
  backendBrandName: document.getElementById('backend-brand-name'),
  backendFooterText: document.getElementById('backend-footer-text'),
  backendLoginLogo: document.getElementById('backend-login-logo'),
  backendLoginLogoLabel: document.getElementById('backend-login-logo-label'),
  frontendSiteTitle: document.getElementById('frontend-site-title'),
  frontendTagline: document.getElementById('frontend-tagline'),
  frontendLogo: document.getElementById('frontend-logo'),
  frontendLogoLabel: document.getElementById('frontend-logo-label'),
  accentColor: document.getElementById('accent-color'),
  customCss: document.getElementById('custom-css'),
  validatePlugins: document.getElementById('validate-plugins'),
  exportProfile: document.getElementById('export-profile'),
  importProfile: document.getElementById('import-profile'),
  validationOutput: document.getElementById('validation-output'),
  startBuild: document.getElementById('start-build'),
  buildStatus: document.getElementById('build-status'),
  buildLogs: document.getElementById('build-logs'),
  downloadLink: document.getElementById('download-link')
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

function escapeHtml(input) {
  return String(input || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function prettyStatus(status) {
  if (status === 'running') return 'Build in progress...';
  if (status === 'completed') return 'Build completed';
  if (status === 'failed') return 'Build failed';
  return 'Idle';
}

function setBuildStatus(message, type = 'info') {
  els.buildStatus.textContent = message;
  els.buildStatus.dataset.type = type;
}

function renderSelectedPlugins() {
  els.selectedPlugins.innerHTML = '';

  if (state.selectedPlugins.length === 0) {
    els.selectedPlugins.innerHTML = '<span class="hint">No plugins selected yet.</span>';
    return;
  }

  state.selectedPlugins.forEach((plugin) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(plugin.slug)} <button aria-label="Remove">&times;</button>`;

    chip.querySelector('button').addEventListener('click', () => {
      state.selectedPlugins = state.selectedPlugins.filter((p) => p.slug !== plugin.slug);
      renderSelectedPlugins();
    });

    els.selectedPlugins.appendChild(chip);
  });
}

function renderUploadedPlugins() {
  els.uploadedPlugins.innerHTML = '';

  if (state.uploadedPlugins.length === 0) {
    els.uploadedPlugins.innerHTML = '<span class="hint">No ZIP files uploaded.</span>';
    return;
  }

  state.uploadedPlugins.forEach((plugin, index) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(plugin.filename)} <button aria-label="Remove">&times;</button>`;

    chip.querySelector('button').addEventListener('click', () => {
      state.uploadedPlugins.splice(index, 1);
      renderUploadedPlugins();
    });

    els.uploadedPlugins.appendChild(chip);
  });
}

function ensurePlugin(slug) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) return;

  if (!state.selectedPlugins.some((plugin) => plugin.slug === normalized)) {
    state.selectedPlugins.push({ slug: normalized });
  }
}

function renderPluginResults(plugins) {
  els.pluginResults.innerHTML = '';

  if (!plugins.length) {
    els.pluginResults.innerHTML = '<span class="hint">No plugins found.</span>';
    return;
  }

  plugins.forEach((plugin) => {
    const card = document.createElement('article');
    card.className = 'plugin-card';

    const compatClass = plugin.compatibility?.status || 'unknown';
    const compatLabel = plugin.compatibility?.note || 'Unknown compatibility';

    card.innerHTML = `
      <div class="title">
        <h4>${escapeHtml(plugin.name)}</h4>
        <span class="compat ${escapeHtml(compatClass)}">${escapeHtml(compatClass)}</span>
      </div>
      <p>${escapeHtml(plugin.shortDescription || '').slice(0, 220)}</p>
      <p><strong>Slug:</strong> ${escapeHtml(plugin.slug)} | <strong>Latest:</strong> ${escapeHtml(plugin.version || 'n/a')}</p>
      <p><strong>Rule:</strong> ${escapeHtml(compatLabel)}</p>
      <button type="button">Add plugin</button>
    `;

    card.querySelector('button').addEventListener('click', () => {
      ensurePlugin(plugin.slug);
      renderSelectedPlugins();
    });

    els.pluginResults.appendChild(card);
  });
}

async function loadVersions() {
  els.wpVersion.innerHTML = '<option>Loading...</option>';

  const { versions } = await api('/api/wordpress/versions');
  els.wpVersion.innerHTML = '';

  versions.forEach((version) => {
    const option = document.createElement('option');
    option.value = version;
    option.textContent = version;
    els.wpVersion.appendChild(option);
  });

  els.wpVersion.value = 'latest';
}

async function searchPlugins() {
  const query = els.pluginQuery.value.trim();
  if (!query) {
    renderPluginResults([]);
    return;
  }

  els.pluginResults.innerHTML = '<span class="hint">Searching...</span>';
  const wpVersion = encodeURIComponent(els.wpVersion.value || 'latest');
  const { plugins } = await api(`/api/plugins/search?q=${encodeURIComponent(query)}&wpVersion=${wpVersion}`);
  renderPluginResults(plugins);
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

async function handleUploadedPluginFiles(files) {
  const incoming = Array.from(files);
  for (const file of incoming) {
    if (!file.name.toLowerCase().endsWith('.zip')) continue;
    const dataBase64 = await fileToBase64(file);

    state.uploadedPlugins.push({
      filename: file.name,
      dataBase64
    });
  }

  renderUploadedPlugins();
}

async function handleImageFile(inputFile, targetKey, labelElement) {
  const file = inputFile?.files?.[0];
  if (!file) {
    state[targetKey] = null;
    labelElement.textContent = 'No file selected.';
    return;
  }

  const dataBase64 = await fileToBase64(file);
  state[targetKey] = {
    filename: file.name,
    dataBase64
  };
  labelElement.textContent = `Loaded: ${file.name}`;
}

function getPayload() {
  return {
    wpVersion: els.wpVersion.value,
    plugins: state.selectedPlugins,
    uploadedPlugins: state.uploadedPlugins,
    branding: {
      backendBrandName: els.backendBrandName.value,
      backendFooterText: els.backendFooterText.value,
      frontendSiteTitle: els.frontendSiteTitle.value,
      frontendTagline: els.frontendTagline.value,
      accentColor: els.accentColor.value,
      customCss: els.customCss.value,
      backendLoginLogo: state.backendLoginLogo,
      frontendLogo: state.frontendLogo
    }
  };
}

async function validatePlugins() {
  if (state.selectedPlugins.length === 0) {
    els.validationOutput.innerHTML = '<span class="hint">Add at least one plugin first.</span>';
    return;
  }

  els.validationOutput.innerHTML = '<span class="hint">Validating plugin resolution...</span>';

  const results = [];
  for (const plugin of state.selectedPlugins) {
    try {
      const response = await api('/api/plugins/resolve', {
        method: 'POST',
        body: JSON.stringify({
          slug: plugin.slug,
          wpVersion: els.wpVersion.value === 'latest' ? null : els.wpVersion.value
        })
      });

      results.push({
        slug: plugin.slug,
        ok: true,
        version: response.plugin.targetVersion,
        note: response.plugin.reason
      });
    } catch (error) {
      results.push({
        slug: plugin.slug,
        ok: false,
        note: error.message
      });
    }
  }

  els.validationOutput.innerHTML = results
    .map((result) => `
      <article class="plugin-card">
        <div class="title">
          <h4>${escapeHtml(result.slug)}</h4>
          <span class="compat ${result.ok ? 'compatible' : 'incompatible'}">${result.ok ? 'ok' : 'error'}</span>
        </div>
        <p>${escapeHtml(result.note)}</p>
        <p>${result.ok ? `<strong>Version to install:</strong> ${escapeHtml(result.version)}` : ''}</p>
      </article>
    `)
    .join('');
}

function exportProfile() {
  const payload = getPayload();
  const serialized = JSON.stringify(payload, null, 2);
  const blob = new Blob([serialized], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `customwp-profile-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click();

  URL.revokeObjectURL(url);
}

async function importProfile(file) {
  if (!file) return;

  const text = await file.text();
  const data = JSON.parse(text);

  els.wpVersion.value = data.wpVersion || 'latest';

  state.selectedPlugins = (data.plugins || [])
    .map((plugin) => ({ slug: String(plugin.slug || '').trim().toLowerCase() }))
    .filter((plugin) => plugin.slug);

  state.uploadedPlugins = Array.isArray(data.uploadedPlugins) ? data.uploadedPlugins : [];
  renderSelectedPlugins();
  renderUploadedPlugins();

  const branding = data.branding || {};
  els.backendBrandName.value = branding.backendBrandName || '';
  els.backendFooterText.value = branding.backendFooterText || '';
  els.frontendSiteTitle.value = branding.frontendSiteTitle || '';
  els.frontendTagline.value = branding.frontendTagline || '';
  els.accentColor.value = branding.accentColor || '#2F6FED';
  els.customCss.value = branding.customCss || '';

  state.backendLoginLogo = branding.backendLoginLogo || null;
  state.frontendLogo = branding.frontendLogo || null;
  els.backendLoginLogoLabel.textContent = state.backendLoginLogo ? `Loaded from profile: ${state.backendLoginLogo.filename}` : 'No file selected.';
  els.frontendLogoLabel.textContent = state.frontendLogo ? `Loaded from profile: ${state.frontendLogo.filename}` : 'No file selected.';

  els.validationOutput.innerHTML = '<span class="hint">Profile imported.</span>';
}

async function pollBuild(id) {
  state.activeBuildId = id;

  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }

  const tick = async () => {
    try {
      const job = await api(`/api/build/${id}`);
      setBuildStatus(prettyStatus(job.status), job.status);
      els.buildLogs.textContent = (job.logs || []).join('\n');

      if (job.status === 'completed' && job.artifact?.downloadUrl) {
        els.downloadLink.href = job.artifact.downloadUrl;
        els.downloadLink.hidden = false;
        clearInterval(state.pollTimer);
      }

      if (job.status === 'failed') {
        clearInterval(state.pollTimer);
      }
    } catch (error) {
      setBuildStatus(`Error: ${error.message}`, 'failed');
      clearInterval(state.pollTimer);
    }
  };

  await tick();
  state.pollTimer = setInterval(tick, 1800);
}

async function startBuild() {
  els.downloadLink.hidden = true;
  els.buildLogs.textContent = '';
  setBuildStatus('Submitting build...', 'running');

  const payload = getPayload();
  const response = await api('/api/build', {
    method: 'POST',
    body: JSON.stringify(payload)
  });

  await pollBuild(response.id);
}

function registerEvents() {
  els.searchPlugins.addEventListener('click', () => {
    searchPlugins().catch((error) => {
      els.pluginResults.innerHTML = `<span class="hint">${escapeHtml(error.message)}</span>`;
    });
  });

  els.pluginQuery.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      els.searchPlugins.click();
    }
  });

  els.uploadPlugins.addEventListener('change', () => {
    handleUploadedPluginFiles(els.uploadPlugins.files).catch((error) => {
      els.validationOutput.innerHTML = `<span class="hint">${escapeHtml(error.message)}</span>`;
    });
  });

  els.backendLoginLogo.addEventListener('change', () => {
    handleImageFile(els.backendLoginLogo, 'backendLoginLogo', els.backendLoginLogoLabel).catch((error) => {
      els.backendLoginLogoLabel.textContent = error.message;
    });
  });

  els.frontendLogo.addEventListener('change', () => {
    handleImageFile(els.frontendLogo, 'frontendLogo', els.frontendLogoLabel).catch((error) => {
      els.frontendLogoLabel.textContent = error.message;
    });
  });

  document.querySelectorAll('.bundle').forEach((button) => {
    button.addEventListener('click', () => {
      const bundleName = button.dataset.bundle;
      const slugs = BUNDLES[bundleName] || [];
      slugs.forEach((slug) => ensurePlugin(slug));
      renderSelectedPlugins();
    });
  });

  els.validatePlugins.addEventListener('click', () => {
    validatePlugins().catch((error) => {
      els.validationOutput.innerHTML = `<span class="hint">${escapeHtml(error.message)}</span>`;
    });
  });

  els.exportProfile.addEventListener('click', exportProfile);
  els.importProfile.addEventListener('change', () => {
    importProfile(els.importProfile.files?.[0]).catch((error) => {
      els.validationOutput.innerHTML = `<span class="hint">Import error: ${escapeHtml(error.message)}</span>`;
    });
  });

  els.startBuild.addEventListener('click', () => {
    startBuild().catch((error) => {
      setBuildStatus(`Error: ${error.message}`, 'failed');
    });
  });
}

async function boot() {
  renderSelectedPlugins();
  renderUploadedPlugins();
  registerEvents();
  await loadVersions();
}

boot().catch((error) => {
  setBuildStatus(`Startup error: ${error.message}`, 'failed');
});
