const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
if (searchInput && searchResults) {
  searchInput.addEventListener('input', async () => {
    const query = searchInput.value.trim();
    if (!query) {
      searchResults.style.display = 'none';
      searchResults.innerHTML = '';
      return;
    }
    try {
      const response = await fetch(`/api/search/repos?q=${encodeURIComponent(query)}`);
      const repos = await response.json();
      if (!repos.length) {
        searchResults.innerHTML = '<div style="padding:12px;color:var(--text-secondary)">No repositories found</div>';
      } else {
        searchResults.innerHTML = repos.map(repo => `<a href="/${repo.full_name}" style="display:block;padding:12px 14px;border-bottom:1px solid var(--border);color:var(--text-primary);text-decoration:none"><strong>${repo.name}</strong><div style="font-size:0.8rem;color:var(--text-secondary)">${repo.owner_name}/${repo.name}</div></a>`).join('');
      }
      searchResults.style.display = 'block';
    } catch (error) {
      searchResults.innerHTML = '<div style="padding:12px;color:#f87171">Search failed</div>';
      searchResults.style.display = 'block';
    }
  });
  document.addEventListener('click', (event) => {
    if (!searchResults.contains(event.target) && event.target !== searchInput) {
      searchResults.style.display = 'none';
    }
  });
}
