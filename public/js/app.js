const SEARCH_DEBOUNCE_MS = 200;

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function renderSearchResults(repos) {
  if (!repos || !repos.length) {
    return '<div style="padding:12px;color:var(--text-secondary)">No repositories found</div>';
  }
  return repos.map((repo) => {
    const name = escapeHtml(repo.name);
    const owner = escapeHtml(repo.owner_name);
    const fullName = escapeHtml(repo.full_name);
    return `<a href="/${fullName}" style="display:block;padding:12px 14px;border-bottom:1px solid var(--border);color:var(--text-primary);text-decoration:none"><strong>${name}</strong><div style="font-size:0.8rem;color:var(--text-secondary)">${owner}/${name}</div></a>`;
  }).join('');
}

function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}

function initSearch(doc) {
  const root = doc || (typeof document !== 'undefined' ? document : null);
  if (!root || typeof root.getElementById !== 'function') return;
  const searchInput = root.getElementById('searchInput');
  const searchResults = root.getElementById('searchResults');
  if (!searchInput || !searchResults) return;

  let requestId = 0;
  const runSearch = async () => {
    const query = searchInput.value.trim();
    const id = ++requestId;
    if (!query) {
      searchResults.style.display = 'none';
      searchResults.innerHTML = '';
      return;
    }
    try {
      const response = await fetch(`/api/search/repos?q=${encodeURIComponent(query)}`);
      const repos = await response.json();
      if (id !== requestId) return;
      searchResults.innerHTML = renderSearchResults(repos);
      searchResults.style.display = 'block';
    } catch {
      if (id !== requestId) return;
      searchResults.innerHTML = '<div style="padding:12px;color:#f87171">Search failed</div>';
      searchResults.style.display = 'block';
    }
  };

  searchInput.addEventListener('input', debounce(runSearch, SEARCH_DEBOUNCE_MS));
  root.addEventListener('click', (event) => {
    if (!searchResults.contains(event.target) && event.target !== searchInput) {
      searchResults.style.display = 'none';
    }
  });
}

initSearch();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, renderSearchResults, debounce, SEARCH_DEBOUNCE_MS, initSearch };
}
