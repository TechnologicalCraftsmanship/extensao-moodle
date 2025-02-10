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
          // Create dates directly in the correct timezone
          const startDate = new Date(event.timestart * 1000);
          const endDate = new Date((event.timestart + event.timeduration) * 1000);
          
          return {
            summary: event.name,
            location: event.location || '',
            start: {
              dateTime: startDate.toISOString(),
              timeZone: 'America/Sao_Paulo'
            },
            end: {
              dateTime: endDate.toISOString(),
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
  const BATCH_SIZE = 10;
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;
  let successCount = 0;
  let errorCount = 0;
  const failedEvents = [];

  // Validate event object
  const validateEvent = (event) => {
    if (!event.summary) throw new Error('Event must have a summary');
    if (!event.start?.dateTime) throw new Error('Event must have a start date');
    if (!event.end?.dateTime) throw new Error('Event must have an end date');
    return true;
  };

  // Helper function to create a single event with retries
  const createSingleEvent = async (event, retryCount = 0) => {
    try {
      validateEvent(event);
      
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
        let errorMessage = 'Unknown error';
        try {
          const errorData = await response.json();
          errorMessage = errorData.error?.message || errorMessage;
        } catch (e) {
          // If response is not JSON, try to get text
          errorMessage = await response.text();
        }

        throw new Error(`Google API error: ${errorMessage}`);
      }

      const result = await response.json();
      console.log('[Google API] Event created:', event.summary, `ID: ${result.id}`);
      successCount++;
      return result;

    } catch (error) {
      if (retryCount < MAX_RETRIES) {
        console.log(`Retrying event creation for "${event.summary}" (attempt ${retryCount + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * (retryCount + 1)));
        return createSingleEvent(event, retryCount + 1);
      }
      
      console.error('[Google API] Failed to create event after retries:', event.summary, error);
      errorCount++;
      failedEvents.push({ event, error: error.message });
      return null;
    }
  };

  try {
    // Process events in batches
    for (let i = 0; i < events.length; i += BATCH_SIZE) {
      const batch = events.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(event => createSingleEvent(event))
      );
      
      // Log batch progress
      console.log(`[Google API] Batch progress: ${i + batch.length}/${events.length} events processed`);
    }

    const summary = {
      total: events.length,
      successful: successCount,
      failed: errorCount,
      failedEvents: failedEvents
    };

    console.log('[Google API] Sync complete:', summary);
    
    if (errorCount > 0) {
      throw new Error(`Event creation partially failed. ${errorCount} events failed to sync.`);
    }

    return summary;
  } catch (error) {
    console.error('[Google API] Sync failed:', error);
    throw error;
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