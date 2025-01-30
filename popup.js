document.getElementById('syncButton').addEventListener('click', () => {
  const startDate = document.getElementById('startDate').value;
  const endDate = document.getElementById('endDate').value;
  
  chrome.runtime.sendMessage({
    action: 'syncEvents',
    dates: { start: startDate, end: endDate }
  }, (response) => {
    document.getElementById('status').textContent = response.message;
  });
}); 