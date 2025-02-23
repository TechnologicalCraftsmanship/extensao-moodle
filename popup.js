// Reset Google Calendar auth
document.getElementById('resetAuth').addEventListener('click', async () => {
  const statusEl = document.getElementById('status');
  statusEl.textContent = 'Resetting Google Calendar access...';
  
  try {
    // Remove cached tokens
    chrome.identity.getAuthToken({ interactive: false }, function(token) {
      if (token) {
        chrome.identity.removeCachedAuthToken({ token: token }, function() {
          console.log('Token removed from cache');
        });
      }
    });

    // Clear any existing grants
    chrome.identity.launchWebAuthFlow({
      url: 'https://accounts.google.com/o/oauth2/revoke',
      interactive: false
    }, function() {
      console.log('Auth flow cleared');
    });
    
    statusEl.className = 'success';
    statusEl.textContent = 'Google Calendar access reset successfully. Please try syncing again to reauthorize.';
  } catch (error) {
    console.error('Reset auth error:', error);
    statusEl.className = 'error';
    statusEl.textContent = 'Access reset completed. Please try syncing again to reauthorize.';
  }
});

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