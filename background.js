// SPDX-License-Identifier: Apache-2.0

// Storage keys and URL patterns live in conversations.js, which the popup loads
// as well so both sides agree on them.

// A conversation that was merely prefetched is still cached: the popup picks
// the one matching its tab, so caching a prefetch is harmless and means the
// transcript is ready the moment that conversation is opened.
chrome.webRequest.onBeforeRequest.addListener(
  function(details) {
    const uuid = conversationUuidFromApiUrl(details.url);
    // Claude issues GETs for the conversation and PUT/POSTs for things like the
    // current leaf message; only the GET carries a transcript.
    const isGet = details.method === "GET";

    dlog("intercept.candidate", {
      id: details.requestId,
      method: details.method,
      type: details.type,
      tab: details.tabId,
      uuid: c2mdShortUuid(uuid),
      willFilter: Boolean(uuid) && isGet,
      url: c2mdShortUrl(details.url)
    });

    if (uuid && isGet) {
      try {
        let filter = browser.webRequest.filterResponseData(details.requestId);
        let decoder = new TextDecoder("utf-8");
        let str = '';
        let chunks = 0;

        filter.ondata = event => {
          chunks += 1;
          str += decoder.decode(event.data, {stream: true});
          filter.write(event.data);
        };

        filter.onerror = event => {
          dlog("intercept.filterError", {
            id: details.requestId,
            error: filter.error,
            chunks: chunks,
            bytesSoFar: str.length
          });
        };

        filter.onstop = event => {
          dlog("intercept.body", Object.assign({
            id: details.requestId,
            chunks: chunks,
            url: c2mdShortUrl(details.url)
          }, c2mdSummarizeBody(str)));

          try {
            const jsonData = JSON.parse(str);
            if (isConversationPayload(jsonData)) {
              dlog("intercept.store", {
                id: details.requestId,
                uuid: c2mdShortUuid(jsonData.uuid),
                msgs: jsonData.chat_messages.length
              });
              storeConversation(details.url, jsonData).catch((e) => {
                dlog("intercept.storeFailed", { id: details.requestId, error: String(e) });
                console.error('Error storing conversation:', e);
              });
            } else {
              // Reached only if a URL slips past the pattern; kept as a guard so
              // a non-conversation body can never replace a transcript.
              dlog("intercept.rejected", {
                id: details.requestId,
                reason: "notAConversationPayload",
                url: c2mdShortUrl(details.url)
              });
            }
          } catch (e) {
            dlog("intercept.notJson", { id: details.requestId, error: String(e) });
            console.log('Not valid JSON:', e);
          }
          filter.disconnect();
        };
      } catch (e) {
        dlog("intercept.attachFailed", { id: details.requestId, error: String(e) });
        console.error('Error intercepting request:', e);
      }
    }
    return { cancel: false };
  },
  {
    urls: ["*://claude.ai/api/organizations/*/chat_conversations/*"],
    types: ["xmlhttprequest"]
  },
  ["blocking"]
);

// Navigating to a conversation -- clicking a sidebar entry, reloading, or
// opening a link -- is the only thing that decides what the popup displays.
// Clicking a sidebar entry issues no request of its own, because the app reuses
// the prefetch that hovering already triggered, so navigation has to be watched
// directly rather than inferred from traffic.
chrome.tabs.onUpdated.addListener(
  (tabId, changeInfo, tab) => {
    const uuid = conversationUuidFromPageUrl(changeInfo.url || (tab && tab.url));
    if (!uuid) {
      return;
    }
    dlog("nav.conversationViewed", { tab: tabId, uuid: c2mdShortUuid(uuid) });
    markConversationViewed(uuid).catch((e) => {
      dlog("nav.markFailed", { uuid: c2mdShortUuid(uuid), error: String(e) });
      console.error('Error marking conversation viewed:', e);
    });
  },
  { urls: ["*://claude.ai/*"], properties: ["status", "url"] }
);

browser.alarms.create("cleanExpiredData", { periodInMinutes: 24 * 60 });

// Listen for the alarm
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cleanExpiredData") {
    cleanExpiredData();
  }
});

// Periodic cleanup function
async function cleanExpiredData() {
  const allData = await chrome.storage.local.get();
  const now = Date.now();
  const keysToRemove = [];

  for (const [key, item] of Object.entries(allData)) {
    if (key.startsWith("gist-") && item.expiry && now > item.expiry) {
      keysToRemove.push(key);
    }
  }

  // Written by versions that kept a single conversation slot; the per-UUID
  // cache replaces it, so it is dead weight holding a transcript.
  if ("lastIntercepted" in allData) {
    keysToRemove.push("lastIntercepted");
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
    console.log(`Cleaned up ${keysToRemove.length} expired items`);
  }

  const pruned = await pruneConversations();
  if (pruned.length > 0) {
    console.log(`Pruned ${pruned.length} cached conversations`);
  }
}

// Run once at startup too: an install that never stays resident long enough for
// the daily alarm would otherwise keep the legacy slot forever.
cleanExpiredData().catch((e) => console.error('Cleanup failed:', e));

dlog("background.loaded", {});
c2mdInstallBackgroundObservers();
