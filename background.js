chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'syncEvents') {
    syncMoodleEvents(request.dates)
      .then(() => sendResponse({ message: 'Sync successful!' }))
      .catch(error => sendResponse({ message: `Error: ${error.message}` }));
    return true; // Keep message channel open for async response
  }
});

async function syncMoodleEvents(dates) {
  // Get MoodleSession cookie
  const cookie = await chrome.cookies.get({
    url: 'https://moodle.utfpr.edu.br',
    name: 'MoodleSession'
  });

  // Fetch Moodle events
  const moodleData = await fetchMoodleData(cookie.value);
  const events = processEvents(moodleData, dates);
  
  // Authenticate with Google Calendar
  const token = await chrome.identity.getAuthToken({ interactive: true });
  await createGoogleEvents(events, token.token);
}

async function fetchMoodleData(sessionCookie) {
  const response = await fetch('https://moodle.utfpr.edu.br/lib/ajax/service.php?sesskey=8mPdcdhDh6&info=block_recentlyaccesseditems_get_recent_items', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `MoodleSession=${sessionCookie}`
    },
    body: JSON.stringify([{
      index: 0,
      methodname: 'block_recentlyaccesseditems_get_recent_items',
      args: { limit: 9 }
    }])
  });
  return response.json();
}

function processEvents(data, dates) {
  // Ensure response structure matches expectations
  if (!data || !data[0] || !data[0].data) return [];
  
  return data[0].data.map(event => ({
    summary: event.name,
    start: { 
      dateTime: new Date(event.timeaccess * 1000).toISOString(),
      timeZone: 'America/Sao_Paulo'  // Add timezone for Brazil
    },
    end: {
      dateTime: new Date(event.timeaccess * 1000 + 3600000).toISOString(), // 1 hour duration
      timeZone: 'America/Sao_Paulo'
    },
    description: `Course: ${event.coursename}\nType: ${event.modname}\nURL: ${event.viewurl}`
  })).filter(event => {
    const eventDate = new Date(event.start.dateTime);
    const startDate = new Date(dates.start);
    const endDate = new Date(dates.end);
    
    // Include whole day range for end date
    endDate.setHours(23, 59, 59, 999);
    
    return eventDate >= startDate && eventDate <= endDate;
  });
}

async function createGoogleEvents(events, accessToken) {
  for (const event of events) {
    await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    });
  }
} 