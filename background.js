let currentSesskey = null;
let sesskeyRetries = 0;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'syncEvents') {
    syncMoodleEvents(request.dates)
      .then(() => sendResponse({ message: 'Sync successful!' }))
      .catch(error => sendResponse({ message: `Error: ${error.message}` }));
    return true; // Keep message channel open for async response
  }
  if (request.action === 'getSesskey') {
    getMoodleSesskey().then(sesskey => sendResponse({ sesskey }))
    return true;
  }
  if (request.type === 'NEW_SESSKEY') {
    currentSesskey = request.sesskey;
  }
});

async function syncMoodleEvents(dates) {
  // Get both cookie and sesskey
  const [cookie, sesskey] = await Promise.all([
    chrome.cookies.get({
      url: 'https://moodle.utfpr.edu.br',
      name: 'MoodleSession'
    }),
    getMoodleSesskey()
  ]);

  // Calculate all months between start and end dates
  const startDate = new Date(dates.start);
  const endDate = new Date(dates.end);
  const monthsToFetch = [];
  let current = new Date(startDate);
  
  // Generate array of {year, month} objects for the range
  while (current <= endDate) {
    monthsToFetch.push({
      year: current.getFullYear(),
      month: current.getMonth() + 1 // Months are 0-based in JS
    });
    current.setMonth(current.getMonth() + 1);
  }

  // Fetch data for all required months in parallel
  const monthlyData = await Promise.all(
    monthsToFetch.map(({year, month}) => 
      fetchMoodleData(cookie.value, sesskey, year, month)
    )
  );

  // Process and filter events
  const allEvents = processEvents(monthlyData.flat(), dates);
  
  // Proper OAuth flow for Chrome extensions
  const { token } = await chrome.identity.getAuthToken({
    interactive: true
  });

  if (!token) {
    throw new Error('Failed to obtain Google OAuth token');
  }

  await createGoogleEvents(allEvents, token);
}

async function getMoodleSesskey() {
  console.log('Starting sesskey retrieval attempt', sesskeyRetries);
  
  if (currentSesskey) {
    console.log('Using cached sesskey:', currentSesskey);
    return currentSesskey;
  }

  // Wait longer between retries
  await new Promise(resolve => setTimeout(resolve, 2500));
  
  if (!currentSesskey) {
    sesskeyRetries++;
    console.log('Sesskey not found, retry count:', sesskeyRetries);
    
    if(sesskeyRetries < 10) { // Increased to 8 retries
      return getMoodleSesskey();
    }
    
    // More detailed error message
    throw new Error(`Sesskey retrieval failed. Please ensure:
    1. You're on a Moodle page (https://moodle.utfpr.edu.br)
    2. You've refreshed the page within the last 2 minutes
    3. You've clicked the calendar/view events at least once
    4. The extension has permission to access Moodle
    5. There are no ad-blockers interfering with requests`);
  }
  
  return currentSesskey;
}

async function fetchMoodleData(sessionCookie, sesskey, year, month) {
  const response = await fetch(`https://moodle.utfpr.edu.br/lib/ajax/service.php?sesskey=${sesskey}&info=core_calendar_get_calendar_monthly_view`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `MoodleSession=${sessionCookie}`
    },
    body: JSON.stringify([{
      index: 0,
      methodname: 'core_calendar_get_calendar_monthly_view',
      args: {
        year: year.toString(),
        month: month.toString(),
        courseid: 1,
        day: 1,
        view: "month"
      }
    }])
  });
  return response.json();
}

function processEvents(monthlyData, dates) {
  // Extract events from all months
  const allEvents = monthlyData.flatMap(monthData => {
    if (!monthData?.[0]?.data?.weeks) return [];
    return monthData[0].data.weeks.flatMap(week => 
      week.days.flatMap(day => 
        day.events.map(event => {
          const formatOptions = {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          };
          
          // Format dates with explicit timezone offset
          const startDate = new Date(event.timestart * 1000).toLocaleString('en-US', formatOptions);
          const endDate = new Date((event.timestart + event.timeduration) * 1000).toLocaleString('en-US', formatOptions);
          
          return {
            summary: event.name,
            location: event.location || '',
            start: {
              dateTime: `${startDate.slice(6,10)}-${startDate.slice(0,2)}-${startDate.slice(3,5)}T${startDate.slice(12)}`,
              timeZone: 'America/Sao_Paulo'
            },
            end: {
              dateTime: `${endDate.slice(6,10)}-${endDate.slice(0,2)}-${endDate.slice(3,5)}T${endDate.slice(12)}`,
              timeZone: 'America/Sao_Paulo'
            },
            description: `Course: ${event.course?.fullname || 'No course'}\n
                         Description: ${event.description}\n
                         URL: ${event.url}`,
            source: {
              title: 'Moodle Event',
              url: event.url
            }
          };
        })
      )
    );
  });

  // Filter events to selected date range
  const start = new Date(dates.start);
  const end = new Date(dates.end);
  end.setHours(23, 59, 59, 999);
  
  return allEvents.filter(event => {
    const eventDate = new Date(event.start.dateTime);
    return eventDate >= start && eventDate <= end;
  });
}

async function createGoogleEvents(events, accessToken) {
  try {
    // Process events in batches to avoid rate limiting
    const BATCH_SIZE = 10;
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      
      await Promise.all(batch.map(async (event) => {
        try {
          const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              ...event,
              reminders: {
                useDefault: true
              }
            })
          });

          if (!response.ok) {
            const errorData = await response.json();
            console.error('Event creation failed:', errorData);
            throw new Error(`Google API error: ${errorData.error?.message || 'Unknown error'}`);
          }

          return await response.json();
        } catch (error) {
          console.error('Failed to create event:', event.summary, error);
          throw error; // Re-throw to stop execution on critical errors
        }
      }));
    }
  } catch (error) {
    throw new Error(`Event creation failed: ${error.message}`);
  }
}

chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        const urlMatch = details.url.match(/[?&]sesskey=([^&]+)/);
        if(urlMatch && urlMatch[1]) {
            console.log('Emergency sesskey capture:', urlMatch[1]);
            currentSesskey = urlMatch[1];
        }
    },
    { urls: ['*://moodle.utfpr.edu.br/*'] }
); 