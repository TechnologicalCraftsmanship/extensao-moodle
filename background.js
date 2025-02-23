let currentSesskey = null;
let sesskeyRetries = 0;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'syncEvents') {
  // First load the courses page to ensure we have a valid sesskey
  loadCoursesPage().then(() => {
    return syncMoodleEvents(request.dates);
  })
      .then((result) => {
        if (result && result.failedEvents && result.failedEvents.length > 0) {
          sendResponse({
            status: 'partial',
            message: `Sync partially complete. ${result.successful} events added, ${result.failed} failed.`,
            details: result
          });
        } else {
          sendResponse({
            status: 'success',
            message: 'Sync successful!',
            details: result
          });
        }
      })
      .catch(error => {
        console.error('Sync error:', error);
        let errorMessage = error.message;
        
        // Provide more specific error messages
        if (errorMessage.includes('OAuth')) {
          errorMessage = 'Google Calendar authentication failed. Please try again.';
        } else if (errorMessage.includes('token')) {
          errorMessage = 'Session expired. Please refresh the page and try again.';
        } else if (errorMessage.includes('quota')) {
          errorMessage = 'Google Calendar API limit reached. Please try again later.';
        }
        
        sendResponse({
          status: 'error',
          message: `Error: ${errorMessage}`,
          details: error
        });
      });
    return true; // Keep message channel open for async response
  }
  if (request.action === 'getSesskey') {
    getMoodleSesskey()
      .then(sesskey => sendResponse({ status: 'success', sesskey }))
      .catch(error => sendResponse({ status: 'error', message: error.message }));
    return true;
  }
  if (request.type === 'NEW_SESSKEY') {
    currentSesskey = request.sesskey;
    sesskeyRetries = 0; // Reset retries when new sesskey is received
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
      month: current.getMonth() + 2 // Months are 0-based in JS
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
  
  console.log('Events to be added:', allEvents);

  // Enhanced OAuth flow with proper error handling
  let token;
  try {
    // Request calendar access with a clear prompt
    token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({
        interactive: true,
        scopes: ['https://www.googleapis.com/auth/calendar.events']
      }, function(token) {
        if (chrome.runtime.lastError) {
          console.error('Auth error:', chrome.runtime.lastError);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(token);
      });
    }).catch(error => {
      console.error('Initial auth error:', error);
      throw new Error('Could not access Google Calendar. Please ensure you are signed into Chrome with your Google account and try again.');
    });

    if (!token) {
      throw new Error('Failed to obtain Calendar access. Please try again and make sure to approve the access request.');
    }

    // Validate token by making a request to tokeninfo endpoint
    const tokenValidation = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);

    if (!tokenValidation.ok) {
      console.log('Invalid token, attempting refresh...');
      await chrome.identity.removeCachedAuthToken({ token });
      token = await chrome.identity.getAuthToken({
        interactive: true,
        force: true
      });
    }
  } catch (error) {
    console.error('OAuth error:', error);
    
    // Handle specific OAuth errors
    if (error.message.includes('user did not approve access')) {
      throw new Error(
        'Calendar access was not approved. Please:\n' +
        '1. Click the extension icon\n' +
        '2. Click "Settings"\n' +
        '3. Click "Reset Google Calendar Access"\n' +
        '4. Try syncing again and approve the Google Calendar access request'
      );
    }
    
    if (error.message.includes('OAuth2 not granted or revoked')) {
      await chrome.identity.removeCachedAuthToken({ token });
      throw new Error(
        'Calendar permissions have been revoked. Please try syncing again and approve the access request.'
      );
    }
    
    throw new Error(`Google Calendar authentication failed. Please ensure you're signed into Chrome with your Google account and try again. Error: ${error.message}`);
  }

  await createGoogleEvents(allEvents, token);
}

async function loadCoursesPage() {
  return new Promise((resolve, reject) => {
    // Reset sesskey state
    currentSesskey = null;
    sesskeyRetries = 0;
    
    let timeoutId;
    
    // Create a listener for sesskey capture
    const sesskeyListener = (request) => {
      if (request.type === 'NEW_SESSKEY' && request.sesskey) {
        chrome.runtime.onMessage.removeListener(sesskeyListener);
        clearTimeout(timeoutId);
        resolve();
      }
    };
    
    chrome.runtime.onMessage.addListener(sesskeyListener);
    
    chrome.tabs.create(
      {
        url: 'https://moodle.utfpr.edu.br/my/courses.php',
        active: false
      },
      (tab) => {
        // Listen for the tab to complete loading
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            // Keep checking for sesskey for up to 30 seconds after page load
            let checkAttempts = 0;
            const checkInterval = setInterval(() => {
              console.log('Checking for sesskey, attempt:', checkAttempts);
              if (currentSesskey) {
                console.log('Sesskey found:', currentSesskey);
                clearInterval(checkInterval);
                chrome.tabs.onUpdated.removeListener(listener);
                // Wait 2 seconds before closing the tab to ensure content script completes
                setTimeout(() => {
                  chrome.tabs.remove(tab.id);
                  resolve();
                }, 2000);
              } else if (checkAttempts >= 60) { // 60 attempts * 500ms = 30 seconds
                clearInterval(checkInterval);
                chrome.tabs.onUpdated.removeListener(listener);
                chrome.tabs.remove(tab.id);
                reject(new Error('Failed to capture sesskey from courses page'));
              }
              checkAttempts++;
            }, 500);
          }
        };
        
        chrome.tabs.onUpdated.addListener(listener);
        
        // Set a timeout to prevent hanging
        timeoutId = setTimeout(() => {
          chrome.runtime.onMessage.removeListener(sesskeyListener);
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.remove(tab.id);
          reject(new Error(`Timeout while loading courses page. Please check:
            1. Your internet connection
            2. You are logged into Moodle
            3. The Moodle site is responding
            
            If the problem persists, try manually visiting
            https://moodle.utfpr.edu.br/my/courses.php
            and then try syncing again.`));
        }, 30000); // Increased timeout to 30 seconds
      }
    );
  });
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
    throw new Error(`Failed to get Moodle session key. Please ensure:
    1. You are logged into Moodle (https://moodle.utfpr.edu.br)
    2. Your internet connection is stable
    3. The extension has permission to access Moodle
    4. There are no ad-blockers or security extensions blocking the request
    5. Try logging out of Moodle, logging back in, and trying again`);
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
    if (!monthData?.data?.weeks) return [];
    return monthData.data.weeks.flatMap(week => 
      week.days.flatMap(day => 
        (day.events || []).map(event => {
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
  console.log('All events:', allEvents);
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

  // Validate and refresh token if needed
  try {
    const tokenInfo = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${accessToken}`);
    
    if (!tokenInfo.ok) {
      console.log('Token invalid or expired, refreshing...');
      await chrome.identity.removeCachedAuthToken({ token: accessToken });
      const newToken = await new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({
          interactive: true,
          force: true,
          scopes: ['https://www.googleapis.com/auth/calendar.events']
        }, function(token) {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(token);
        });
      });
      return createGoogleEvents(events, newToken);
    }
  } catch (error) {
    console.error('Token validation failed:', error);
    throw new Error('Failed to validate Google token: ' + error.message);
  }

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