// PolyCrawler Frontend Application

let crawlResults = [];
let filteredResults = [];
let crawlLogs = [];
let currentSort = { field: null, direction: 'asc' };

// DOM Elements
const elements = {
  runCrawl: document.getElementById('runCrawl'),
  btnText: document.querySelector('.btn-text'),
  btnLoading: document.querySelector('.btn-loading'),
  marketLimit: document.getElementById('marketLimit'),
  topContenders: document.getElementById('topContenders'),
  stats: document.getElementById('stats'),
  actions: document.getElementById('actions'),
  emptyState: document.getElementById('emptyState'),
  tableContainer: document.getElementById('tableContainer'),
  resultsBody: document.getElementById('resultsBody'),
  filterInput: document.getElementById('filterInput'),
  filterStatus: document.getElementById('filterStatus'),
  exportCsv: document.getElementById('exportCsv'),
  copyClipboard: document.getElementById('copyClipboard'),
  openSheetsConfig: document.getElementById('openSheetsConfig'),
  sheetsModal: document.getElementById('sheetsModal'),
  closeModal: document.getElementById('closeModal'),
  sheetsWebAppUrl: document.getElementById('sheetsWebAppUrl'),
  exportToSheets: document.getElementById('exportToSheets'),
  sheetsStatus: document.getElementById('sheetsStatus'),
  appsScriptCode: document.getElementById('appsScriptCode'),
  copyAppsScript: document.getElementById('copyAppsScript'),
  // Stats
  statMarkets: document.getElementById('statMarkets'),
  statContenders: document.getElementById('statContenders'),
  statFound: document.getElementById('statFound'),
  statNoWiki: document.getElementById('statNoWiki'),
  statNoDate: document.getElementById('statNoDate'),
  // Log panel
  logPanel: document.getElementById('logPanel'),
  logContent: document.getElementById('logContent'),
  logLevelFilter: document.getElementById('logLevelFilter'),
  toggleLogPanel: document.getElementById('toggleLogPanel'),
  copyLogs: document.getElementById('copyLogs'),
  clearLogs: document.getElementById('clearLogs'),
};

// Google Apps Script code for the modal
const appsScriptCode = `function doPost(e) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  const data = JSON.parse(e.postData.contents);

  // Clear existing data (keep headers if they exist)
  if (sheet.getLastRow() > 1) {
    sheet.deleteRows(2, sheet.getLastRow() - 1);
  }

  // Set headers if sheet is empty
  if (sheet.getLastRow() === 0) {
    const headers = ['Person Name', 'Birth Date', 'Probability',
                     'Market Title', 'Market Deadline', 'Market Volume', 'Status', 'Wikipedia URL', 'Updated'];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }

  // Add data rows
  for (const row of data.results) {
    sheet.appendRow([
      row.personName,
      row.birthDate || 'N/A',
      (row.probability || 0).toFixed(1) + '%',
      row.marketTitle,
      row.marketEndDate || 'N/A',
      '$' + (row.marketVolume || 0).toLocaleString(),
      row.status,
      row.wikipediaUrl || 'N/A',
      new Date().toISOString()
    ]);
  }

  return ContentService.createTextOutput(JSON.stringify({ success: true, rows: data.results.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService.createTextOutput('PolyCrawler Google Sheets endpoint. Use POST to send data.')
    .setMimeType(ContentService.MimeType.TEXT);
}`;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  elements.appsScriptCode.textContent = appsScriptCode;

  // Load saved web app URL
  const savedUrl = localStorage.getItem('sheetsWebAppUrl');
  if (savedUrl) {
    elements.sheetsWebAppUrl.value = savedUrl;
    elements.exportToSheets.disabled = false;
  }

  setupEventListeners();
});

function setupEventListeners() {
  // Run crawl
  elements.runCrawl.addEventListener('click', runCrawl);

  // Filters
  elements.filterInput.addEventListener('input', applyFilters);
  elements.filterStatus.addEventListener('change', applyFilters);

  // Export
  elements.exportCsv.addEventListener('click', exportToCsv);
  elements.copyClipboard.addEventListener('click', copyToClipboard);

  // Google Sheets modal
  elements.openSheetsConfig.addEventListener('click', () => {
    elements.sheetsModal.classList.add('active');
  });

  elements.closeModal.addEventListener('click', () => {
    elements.sheetsModal.classList.remove('active');
  });

  elements.sheetsModal.addEventListener('click', (e) => {
    if (e.target === elements.sheetsModal) {
      elements.sheetsModal.classList.remove('active');
    }
  });

  elements.sheetsWebAppUrl.addEventListener('input', () => {
    const url = elements.sheetsWebAppUrl.value.trim();
    elements.exportToSheets.disabled = !url.startsWith('https://script.google.com/');
    if (url) {
      localStorage.setItem('sheetsWebAppUrl', url);
    }
  });

  elements.exportToSheets.addEventListener('click', exportToSheets);
  elements.copyAppsScript.addEventListener('click', () => {
    navigator.clipboard.writeText(appsScriptCode);
    elements.copyAppsScript.textContent = 'Copied!';
    setTimeout(() => {
      elements.copyAppsScript.textContent = 'Copy Code';
    }, 2000);
  });

  // Table sorting
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      sortResults(field);
    });
  });

  // Log panel controls
  elements.logLevelFilter.addEventListener('change', renderLogs);

  elements.toggleLogPanel.addEventListener('click', () => {
    elements.logPanel.classList.toggle('collapsed');
    elements.toggleLogPanel.textContent =
      elements.logPanel.classList.contains('collapsed') ? 'Show' : 'Hide';
  });

  elements.copyLogs.addEventListener('click', () => {
    const logText = crawlLogs.map(log =>
      `[${log.timestamp}] [${log.level}] ${log.message}${log.data ? '\n  ' + JSON.stringify(log.data, null, 2) : ''}`
    ).join('\n');

    navigator.clipboard.writeText(logText).then(() => {
      elements.copyLogs.textContent = 'Copied!';
      setTimeout(() => {
        elements.copyLogs.textContent = 'Copy Logs';
      }, 2000);
    });
  });

  elements.clearLogs.addEventListener('click', () => {
    crawlLogs = [];
    renderLogs();
  });

  // Log data expand/collapse
  elements.logContent.addEventListener('click', (e) => {
    if (e.target.classList.contains('log-data') || e.target.closest('.log-data')) {
      const logData = e.target.classList.contains('log-data') ? e.target : e.target.closest('.log-data');
      logData.classList.toggle('collapsed');
    }
  });
}

async function runCrawl() {
  const limit = parseInt(elements.marketLimit.value) || 50;
  const top = parseInt(elements.topContenders.value) || 4;
  const BATCH_SIZE = 5; // Look up 5 people per request

  // Update UI
  elements.runCrawl.disabled = true;
  elements.btnText.style.display = 'none';
  elements.btnLoading.style.display = 'inline';
  elements.emptyState.innerHTML = '<p>Fetching markets...</p>';
  elements.stats.style.display = 'flex';
  elements.tableContainer.style.display = 'block';

  // Clear previous results and logs
  crawlResults = [];
  filteredResults = [];
  crawlLogs = [];
  const wikiResults = new Map(); // nameKey -> wiki result
  let peopleData = []; // Store people with their market associations

  addLocalLog('INFO', 'Starting chunked crawl...', { limit, top });
  renderLogs();
  renderResults();

  try {
    // Phase 1: Fetch markets and get list of people
    addLocalLog('INFO', 'Phase 1: Fetching markets...');
    elements.emptyState.innerHTML = '<p>Fetching markets and extracting names...</p>';

    const marketsResponse = await fetch(`/api/crawl?phase=markets&limit=${limit}&top=${top}`);
    const marketsData = await marketsResponse.json();

    if (marketsData.logs) {
      crawlLogs = [...crawlLogs, ...marketsData.logs];
      renderLogs();
    }

    if (!marketsData.success) {
      throw new Error(marketsData.error || 'Failed to fetch markets');
    }

    peopleData = marketsData.people || [];
    const totalPeople = peopleData.length;

    addLocalLog('INFO', 'Markets fetched', {
      markets: marketsData.markets?.length || 0,
      uniquePeople: totalPeople
    });

    if (totalPeople === 0) {
      elements.emptyState.innerHTML = '<p style="color: var(--warning);">No people found in markets.</p>';
      return;
    }

    // Phase 2: Look up people in batches, showing results progressively
    const names = peopleData.map(p => p.name);
    let lookedUp = 0;

    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      const batch = names.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(names.length / BATCH_SIZE);

      elements.emptyState.innerHTML = `<p>Looking up Wikipedia... (${lookedUp}/${totalPeople} people)</p>`;
      addLocalLog('INFO', `Looking up batch ${batchNum}/${totalBatches}`, { names: batch });

      try {
        const lookupResponse = await fetch(`/api/crawl?phase=lookup&names=${encodeURIComponent(JSON.stringify(batch))}`);
        const lookupData = await lookupResponse.json();

        if (lookupData.logs) {
          crawlLogs = [...crawlLogs, ...lookupData.logs];
          renderLogs();
        }

        if (lookupData.success && lookupData.results) {
          for (const result of lookupData.results) {
            wikiResults.set(result.name.toLowerCase(), result);
          }
          lookedUp += batch.length;

          // Rebuild and display results progressively
          rebuildResults(peopleData, wikiResults);
          updateStatsFromResults();
          renderResults();
        }
      } catch (batchError) {
        addLocalLog('WARN', `Batch ${batchNum} failed`, { error: batchError.message });
        // Continue with next batch
      }
    }

    // Final update
    elements.emptyState.style.display = 'none';
    addLocalLog('INFO', 'Crawl completed', {
      totalPeople: crawlResults.length,
      birthDatesFound: crawlResults.filter(r => r.birthDate).length
    });

  } catch (error) {
    console.error('Crawl error:', error);
    addLocalLog('ERROR', 'Crawl failed', { message: error.message });
    elements.emptyState.innerHTML = `<p style="color: var(--danger);">Error: ${error.message}</p>`;
    elements.emptyState.style.display = 'block';
  } finally {
    elements.runCrawl.disabled = false;
    elements.btnText.style.display = 'inline';
    elements.btnLoading.style.display = 'none';
    elements.actions.style.display = 'flex';
    renderLogs();
  }
}

function rebuildResults(peopleData, wikiResults) {
  crawlResults = [];

  for (const person of peopleData) {
    const wikiResult = wikiResults.get(person.nameKey);

    for (const market of person.markets) {
      crawlResults.push({
        marketTitle: market.title,
        marketSlug: market.slug,
        marketConditionId: market.conditionId,
        marketVolume: market.volume,
        marketEndDate: market.endDate,
        personName: person.name,
        probability: market.probability,
        nameSource: market.source,
        ...(wikiResult || { found: false, status: 'Pending...' })
      });
    }
  }

  filteredResults = [...crawlResults];
}

function updateStatsFromResults() {
  updateStats({
    totalMarkets: new Set(crawlResults.map(r => r.marketTitle)).size,
    totalPeople: crawlResults.length,
    birthDatesFound: crawlResults.filter(r => r.birthDate).length,
    wikipediaNotFound: crawlResults.filter(r => r.status && r.status.includes('not found')).length,
    birthDateMissing: crawlResults.filter(r => r.found && !r.birthDate).length
  });
}

function addLocalLog(level, message, data = null) {
  crawlLogs.push({
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
    isLocal: true
  });
}

function renderLogs() {
  const filterLevel = elements.logLevelFilter.value;

  const filteredLogs = filterLevel === 'all'
    ? crawlLogs
    : crawlLogs.filter(log => log.level === filterLevel);

  if (filteredLogs.length === 0) {
    elements.logContent.innerHTML = '<div class="log-empty">No logs yet. Run a crawl to see detailed logs.</div>';
    return;
  }

  elements.logContent.innerHTML = filteredLogs.map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString();
    const dataHtml = log.data
      ? `<div class="log-data collapsed">${escapeHtml(JSON.stringify(log.data, null, 2))}</div>`
      : '';

    return `
      <div class="log-entry">
        <span class="log-timestamp">${time}</span>
        <span class="log-level ${log.level}">${log.level}</span>
        <div class="log-message">
          ${escapeHtml(log.message)}
          ${dataHtml}
        </div>
      </div>
    `;
  }).join('');

  // Scroll to bottom
  elements.logContent.scrollTop = elements.logContent.scrollHeight;
}

function updateStats(stats) {
  elements.statMarkets.textContent = stats.totalMarkets;
  elements.statContenders.textContent = stats.totalContenders;
  elements.statFound.textContent = stats.birthDatesFound;
  elements.statNoWiki.textContent = stats.wikipediaNotFound;
  elements.statNoDate.textContent = stats.birthDateMissing;
}

function renderResults() {
  elements.resultsBody.innerHTML = filteredResults.map(r => `
    <tr>
      <td><strong>${escapeHtml(r.personName)}</strong></td>
      <td>${r.birthDate || '-'}</td>
      <td class="probability">${r.probability ? r.probability.toFixed(1) + '%' : '-'}</td>
      <td class="market-title" title="${escapeHtml(r.marketTitle)}">${escapeHtml(r.marketTitle)}</td>
      <td>${formatDeadline(r.marketEndDate)}</td>
      <td><span class="status-badge ${getStatusClass(r.status)}">${r.status}</span></td>
      <td class="link-cell">
        ${r.wikipediaUrl ? `<a href="${r.wikipediaUrl}" target="_blank">Wikipedia</a>` : ''}
        ${getMarketLink(r)}
      </td>
    </tr>
  `).join('');
}

function formatDeadline(dateStr) {
  if (!dateStr) return '-';
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function getStatusClass(status) {
  if (status === 'Found') return 'status-found';
  if (status.includes('Birth date not found')) return 'status-no-date';
  return 'status-no-wiki';
}

function getMarketLink(result) {
  // Try slug first (for event URL)
  if (result.marketSlug) {
    return `<a href="https://polymarket.com/event/${encodeURIComponent(result.marketSlug)}" target="_blank">Market</a>`;
  }
  // Fall back to conditionId (direct market URL)
  if (result.marketConditionId) {
    return `<a href="https://polymarket.com/market/${encodeURIComponent(result.marketConditionId)}" target="_blank">Market</a>`;
  }
  return '';
}

function applyFilters() {
  const searchText = elements.filterInput.value.toLowerCase();
  const statusFilter = elements.filterStatus.value;

  filteredResults = crawlResults.filter(r => {
    // Text filter
    if (searchText) {
      const matchesText =
        r.personName.toLowerCase().includes(searchText) ||
        r.marketTitle.toLowerCase().includes(searchText);
      if (!matchesText) return false;
    }

    // Status filter
    if (statusFilter !== 'all') {
      if (statusFilter === 'found' && r.status !== 'Found') return false;
      if (statusFilter === 'no-date' && !r.status.includes('Birth date not found')) return false;
      if (statusFilter === 'no-wiki' && r.found !== false) return false;
    }

    return true;
  });

  renderResults();
}

function sortResults(field) {
  // Toggle direction
  if (currentSort.field === field) {
    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.field = field;
    currentSort.direction = 'asc';
  }

  // Update header classes
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === field) {
      th.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });

  // Sort
  filteredResults.sort((a, b) => {
    let aVal = a[field];
    let bVal = b[field];

    // Handle null/undefined
    if (aVal == null) aVal = '';
    if (bVal == null) bVal = '';

    // Compare
    let comparison = 0;
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      comparison = aVal - bVal;
    } else {
      comparison = String(aVal).localeCompare(String(bVal));
    }

    return currentSort.direction === 'asc' ? comparison : -comparison;
  });

  renderResults();
}

function exportToCsv() {
  const headers = ['Person Name', 'Birth Date', 'Birth Date (Raw)', 'Probability %',
                   'Market Title', 'Market Deadline', 'Market Volume',
                   'Status', 'Wikipedia URL', 'Market URL'];

  const rows = filteredResults.map(r => [
    r.personName,
    r.birthDate || '',
    r.birthDateRaw || '',
    r.probability?.toFixed(1) || '',
    r.marketTitle,
    r.marketEndDate || '',
    r.marketVolume || '',
    r.status,
    r.wikipediaUrl || '',
    r.marketSlug ? `https://polymarket.com/event/${r.marketSlug}` : (r.marketConditionId ? `https://polymarket.com/market/${r.marketConditionId}` : '')
  ]);

  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `polycrawler_${new Date().toISOString().split('T')[0]}.csv`;
  link.click();
}

function copyToClipboard() {
  const text = filteredResults.map(r =>
    `${r.personName}\t${r.birthDate || '-'}\t${r.probability?.toFixed(1) || '-'}%\t${r.marketTitle}\t${r.marketEndDate || '-'}`
  ).join('\n');

  navigator.clipboard.writeText(text).then(() => {
    elements.copyClipboard.textContent = 'Copied!';
    setTimeout(() => {
      elements.copyClipboard.textContent = 'Copy to Clipboard';
    }, 2000);
  });
}

async function exportToSheets() {
  const url = elements.sheetsWebAppUrl.value.trim();
  if (!url) return;

  elements.exportToSheets.disabled = true;
  elements.sheetsStatus.textContent = 'Exporting...';
  elements.sheetsStatus.className = 'status-message';

  try {
    const response = await fetch(url, {
      method: 'POST',
      mode: 'no-cors', // Google Apps Script doesn't support CORS properly
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ results: filteredResults })
    });

    // With no-cors, we can't read the response, but if it didn't throw, it likely worked
    elements.sheetsStatus.textContent = 'Export sent! Check your Google Sheet.';
    elements.sheetsStatus.className = 'status-message success';

  } catch (error) {
    elements.sheetsStatus.textContent = `Error: ${error.message}`;
    elements.sheetsStatus.className = 'status-message error';
  } finally {
    elements.exportToSheets.disabled = false;
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
