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
  const response = await fetch(`https://moodle.utfpr.edu.br/lib/ajax/service.php?sesskey=${sessionCookie}&info=core_calendar_get_calendar_monthly_view`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `MoodleSession=${sessionCookie}`
    },
    body: JSON.stringify([{
      index: 0,
      methodname: 'core_calendar_get_calendar_monthly_view',
      args: {
        year: "2025",
        month: "2",
        courseid: 1,
        day: 1,
        view: "month"
      }
    }])
  });
  return response.json();
}

function processEvents(data, dates) {
  // Handle Moodle's nested response structure
  if (!data || !data[0] || !data[0].data?.weeks) return [];
  
  // Extract events from all weeks and days
  const allEvents = data[0].data.weeks.flatMap(week => 
    week.days.flatMap(day => 
      day.events.map(event => ({
        summary: event.name,
        start: {
          dateTime: new Date(event.timestart * 1000).toISOString(),
          timeZone: 'America/Sao_Paulo'
        },
        end: {
          dateTime: new Date((event.timestart + event.timeduration) * 1000).toISOString(),
          timeZone: 'America/Sao_Paulo'
        },
        description: `Course: ${event.course?.fullname || 'No course'}\n${event.description}\nURL: ${event.url}`
      }))
    )
  );

  // Filter events within date range
  return allEvents.filter(event => {
    const eventDate = new Date(event.start.dateTime);
    const startDate = new Date(dates.start);
    const endDate = new Date(dates.end);
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