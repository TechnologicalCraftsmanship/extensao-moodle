// Add at the top of the content script
console.log('Moodle content script loaded');

// Function to send sesskey to background script
const sendSesskey = (sesskey) => {
    if (sesskey) {
        chrome.runtime.sendMessage({
            type: 'NEW_SESSKEY',
            sesskey: sesskey
        });
    }
};

// Check for sesskey when page loads and after any dynamic content changes
const checkForSesskey = () => {
    const sesskey = extractSesskeyFromPage();
    sendSesskey(sesskey);
};

// Run on initial page load
document.addEventListener('DOMContentLoaded', checkForSesskey);

// Monitor DOM changes for dynamically added content
const observer = new MutationObserver(checkForSesskey);
observer.observe(document.documentElement, {
    childList: true,
    subtree: true
});

// Monitor all network requests for sesskey
(function() {
    const captureSesskey = (request) => {
        // Direct URL parameter check
        const urlParts = request.url.split('?');
        if(urlParts.length > 1) {
            const params = new URLSearchParams(urlParts[1]);
            if(params.has('sesskey')) {
                const foundKey = params.get('sesskey');
                console.log('Direct sesskey capture:', foundKey);
                chrome.runtime.sendMessage({
                    type: 'NEW_SESSKEY',
                    sesskey: foundKey
                });
                return; // Skip body check if found in URL
            }
        }
        
        // Deep scan JSON body
        if (request.body && typeof request.body === 'string') {
            try {
                const jsonBody = JSON.parse(request.body);
                if(jsonBody.sesskey) {
                    console.log('Found sesskey in JSON body:', jsonBody.sesskey);
                    chrome.runtime.sendMessage({
                        type: 'NEW_SESSKEY',
                        sesskey: jsonBody.sesskey
                    });
                }
            } catch (e) {
                // Handle non-JSON bodies
                const bodyParams = new URLSearchParams(request.body);
                if(bodyParams.has('sesskey')) {
                    console.log('Found sesskey in POST body:', bodyParams.get('sesskey'));
                    chrome.runtime.sendMessage({
                        type: 'NEW_SESSKEY',
                        sesskey: bodyParams.get('sesskey')
                    });
                }
            }
        }
    };

    // Enhanced fetch interceptor
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
        const request = new Request(input, init);
        try {
            // Clone request to read body without consumption
            const clonedRequest = request.clone();
            const body = await clonedRequest.text();
            
            captureSesskey({
                url: request.url,
                body: body,
                method: request.method
            });
        } catch (error) {
            console.error('Error intercepting fetch:', error);
        }
        return originalFetch(input, init);
    };

    // Enhanced XHR interceptor
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
        this.addEventListener('loadstart', () => {
            captureSesskey({
                url: this.responseURL,
                body: body
            });
        });
        return originalSend.call(this, body);
    };
})(); 