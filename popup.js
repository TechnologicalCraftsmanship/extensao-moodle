document.getElementById('syncButton').addEventListener('click', () => {
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  const statusEl = document.getElementById('status');
  
  // Disable button during sync
  const syncButton = document.getElementById('syncButton');
  syncButton.disabled = true;
  statusEl.textContent = 'Syncing events...';
  
  chrome.runtime.sendMessage({
    action: 'syncEvents',
    dates: { start: startDate, end: endDate }
  }, (response) => {
    syncButton.disabled = false;
    
    statusEl.className = response.status; // 'success', 'error', or 'partial'
    statusEl.textContent = response.message;
    
    if (response.status === 'partial' && response.details) {
      const details = document.createElement('div');
      details.className = 'sync-details';
      details.textContent = `Successfully added: ${response.details.successful}
                           Failed: ${response.details.failed}`;
      statusEl.appendChild(details);
    }
  });
});