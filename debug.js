// SPDX-License-Identifier: Apache-2.0
//
// Diagnostic instrumentation, shared by the background script and the popup.
//
// Every record is a single line of the form `[c2md] {...json...}` so a session
// log can be grepped and parsed. To see these lines in a terminal, launch via
// dev-run.sh, which sets the prefs that make them reach stdout; otherwise they
// are only visible in about:debugging.
//
// Set C2MD_DEBUG to true to turn the instrumentation on. It is off in shipped
// builds; dev-run.sh is the intended way to use it.

const C2MD_DEBUG = false;
const C2MD_TAG = "[c2md]";
const C2MD_BOOT = Date.now();

// An extension holding host permissions runs in the extension child process,
// whose console output never reaches Firefox's stdout and therefore never
// reaches a terminal log. dump() does reach stdout, given the
// browser.dom.window.dump.enabled pref that dev-run.sh sets, so it is the
// primary sink. console.log is only a fallback, for when the extension is
// loaded by hand through about:debugging instead of dev-run.sh; emitting to
// both would duplicate every record in the log.
function c2mdEmit(line) {
  try {
    if (typeof dump === "function") {
      dump(line + "\n");
      return;
    }
  } catch (e) {
    // dump() disabled by pref; fall through to the console.
  }
  console.log(line);
}

function dlog(ev, fields) {
  if (!C2MD_DEBUG) {
    return;
  }
  let line;
  try {
    line = JSON.stringify(Object.assign({
      ev: ev,
      ms: Date.now() - C2MD_BOOT,
      clock: new Date().toISOString().slice(11, 23)
    }, fields || {}));
  } catch (e) {
    line = JSON.stringify({ ev: ev, dlogError: String(e) });
  }
  c2mdEmit(`${C2MD_TAG} ${line}`);
}

// Collapse the org UUID so URLs stay readable in the log, but keep the query
// string: which query params Claude sends is part of what we are diagnosing.
function c2mdShortUrl(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/api\/organizations\/[^/]+/, "/api/org") + u.search;
  } catch (e) {
    return String(url);
  }
}

function c2mdShortUuid(uuid) {
  return typeof uuid === "string" ? uuid.slice(0, 8) : uuid;
}

// Describe a response body without dumping conversation content into the log.
// The shape is what matters: whether it parsed, which top-level keys it has,
// and whether it actually carries chat_messages.
function c2mdSummarizeBody(str) {
  const out = { len: str.length };
  let data;
  try {
    data = JSON.parse(str);
  } catch (e) {
    out.parse = "fail";
    out.head = str.slice(0, 200);
    return out;
  }
  out.parse = "ok";

  if (Array.isArray(data)) {
    out.shape = "array";
    out.n = data.length;
    return out;
  }
  if (data === null || typeof data !== "object") {
    out.shape = typeof data;
    return out;
  }

  out.shape = "object";
  out.keys = Object.keys(data).sort();
  if (typeof data.uuid === "string") {
    out.uuid = c2mdShortUuid(data.uuid);
  }
  if (typeof data.name === "string") {
    out.name = data.name.slice(0, 48);
  }

  const messages = data.chat_messages;
  if (!("chat_messages" in data)) {
    out.msgs = "KEY_ABSENT";
  } else if (!Array.isArray(messages)) {
    out.msgs = `NOT_ARRAY:${typeof messages}`;
  } else {
    out.msgs = messages.length;
    const contentTypes = {};
    let noAttachments = 0;
    let noContentArray = 0;
    messages.forEach((m) => {
      if (!Array.isArray(m.attachments)) {
        noAttachments += 1;
      }
      if (!Array.isArray(m.content)) {
        noContentArray += 1;
        return;
      }
      m.content.forEach((c) => {
        const key = (c && c.type) || "MISSING_TYPE";
        contentTypes[key] = (contentTypes[key] || 0) + 1;
      });
    });
    out.contentTypes = contentTypes;
    // Both of these would make buildMarkdown throw rather than return text.
    out.msgsWithoutAttachmentsArray = noAttachments;
    out.msgsWithoutContentArray = noContentArray;
  }
  return out;
}

// Background-only observers. The popup must not call this: it would register a
// duplicate set of webRequest listeners and double every record.
function c2mdInstallBackgroundObservers() {
  if (!C2MD_DEBUG) {
    return;
  }

  // Deliberately unfiltered by `types`. If Claude fetches a conversation as
  // something other than an xmlhttprequest (a prefetch, say), the production
  // listener's type check would silently drop it and only this observer would
  // show it.
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      dlog("api.request", {
        id: details.requestId,
        method: details.method,
        type: details.type,
        tab: details.tabId,
        frame: details.frameId,
        url: c2mdShortUrl(details.url)
      });
    },
    { urls: ["*://claude.ai/api/*"] }
  );

  chrome.webRequest.onCompleted.addListener(
    (details) => {
      dlog("api.completed", {
        id: details.requestId,
        method: details.method,
        status: details.statusCode,
        fromCache: details.fromCache,
        url: c2mdShortUrl(details.url)
      });
    },
    { urls: ["*://claude.ai/api/*"] }
  );

  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      dlog("api.error", {
        id: details.requestId,
        error: details.error,
        url: c2mdShortUrl(details.url)
      });
    },
    { urls: ["*://claude.ai/api/*"] }
  );

  // Which conversation the tab is actually displaying — the thing the popup
  // needs to agree with, and the reference point for "off by one".
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status) {
      dlog("tab.updated", {
        tab: tabId,
        status: changeInfo.status,
        changedUrl: changeInfo.url ? c2mdShortUrl(changeInfo.url) : undefined,
        tabUrl: tab && tab.url ? c2mdShortUrl(tab.url) : undefined
      });
    }
  }, { urls: ["*://claude.ai/*"], properties: ["status", "url"] });

  // Every write to a cached conversation, in order. Each conversation has its
  // own key, so a write can no longer displace a different conversation --
  // which is the property these records exist to confirm. Entries are
  // recognised by shape so this file needs nothing from the storage layer.
  chrome.storage.onChanged.addListener((changes, area) => {
    Object.keys(changes).forEach((key) => {
      const next = changes[key].newValue;
      const previous = changes[key].oldValue;
      const content = (next && next.content) || (previous && previous.content);
      if (!content || typeof content.uuid !== "string") {
        dlog("storage.changed", { area: area, key: key });
        return;
      }
      dlog("storage.conversation", {
        area: area,
        action: next ? "write" : "remove",
        uuid: c2mdShortUuid(content.uuid),
        msgs: Array.isArray(content.chat_messages) ? content.chat_messages.length : null,
        name: typeof content.name === "string" ? content.name.slice(0, 40) : null
      });
    });
  });

  dlog("debug.observersInstalled", {});
}
