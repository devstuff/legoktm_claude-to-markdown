// SPDX-License-Identifier: Apache-2.0
//
// Storage layer shared by the background script and the popup.
//
// Two ideas carry this file:
//
//   1. Conversations are cached per UUID, not in one "last intercepted" slot.
//      Claude prefetches a conversation whenever the pointer crosses its entry
//      in the sidebar, so a single slot ends up holding whichever conversation
//      was hovered over most recently instead of the one on screen.
//
//   2. Being cached and being displayed are different things. A conversation is
//      only displayed once it has actually been navigated to. This matters
//      because clicking a sidebar entry issues no request of its own -- the app
//      reuses the hover prefetch -- so the cache cannot be limited to
//      conversations the user opened, and "most recently cached" cannot be
//      allowed to mean "what to show".

const CONVERSATION_KEY_PREFIX = "conv-";

// The conversation the user last navigated to. This is what the popup falls
// back to when its tab is not itself a conversation page, and it is updated
// only by navigation -- never by a fetch.
const LAST_VIEWED_KEY = "lastViewedConversation";

// Large enough that a sweep of the sidebar cannot push out a conversation the
// user is about to click; the entry being displayed is protected from eviction
// regardless.
const CONVERSATION_CACHE_LIMIT = 10;
const CONVERSATION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// The conversation resource itself, and nothing below it. The trailing
// (?:\?|$) is load-bearing: without it, sub-resources such as
// /composer_notices and /shares also match, and their bodies -- {"notices":[]}
// and [] -- overwrite a perfectly good conversation with something that has no
// chat_messages, blanking the popup.
const CONVERSATION_API_PATTERN =
  /^https:\/\/claude\.ai\/api\/organizations\/[\w-]+\/chat_conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\?|$)/;

// The address bar form, e.g. https://claude.ai/chat/<uuid>.
const CONVERSATION_PAGE_PATTERN =
  /^https:\/\/claude\.ai\/chat\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

function conversationKey(uuid) {
  return `${CONVERSATION_KEY_PREFIX}${uuid}`;
}

// Returns the conversation UUID an API URL refers to, or null if the URL is not
// the conversation resource itself.
function conversationUuidFromApiUrl(url) {
  const match = CONVERSATION_API_PATTERN.exec(url);
  return match ? match[1] : null;
}

// Returns the conversation UUID a tab is displaying, or null for any other page
// (the conversation list, a project, a non-Claude tab).
function conversationUuidFromPageUrl(url) {
  if (typeof url !== "string") {
    return null;
  }
  const match = CONVERSATION_PAGE_PATTERN.exec(url);
  return match ? match[1] : null;
}

// A response body is only a conversation if it is an object carrying both an
// identity and a message list. Matching the URL is not enough on its own:
// treating this as a second, independent check means a future sub-resource
// cannot blank the popup even if it slips past the URL pattern.
function isConversationPayload(data) {
  return Boolean(data)
    && typeof data === "object"
    && !Array.isArray(data)
    && typeof data.uuid === "string"
    && Array.isArray(data.chat_messages);
}

async function getAllConversations() {
  const all = await chrome.storage.local.get();
  const entries = [];
  for (const [key, entry] of Object.entries(all)) {
    if (key.startsWith(CONVERSATION_KEY_PREFIX) && entry && entry.content) {
      entries.push({ key: key, entry: entry });
    }
  }
  entries.sort((a, b) => Date.parse(b.entry.timestamp) - Date.parse(a.entry.timestamp));
  return entries;
}

async function getConversation(uuid) {
  if (!uuid) {
    return null;
  }
  const key = conversationKey(uuid);
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function getLastViewedUuid() {
  const data = await chrome.storage.local.get(LAST_VIEWED_KEY);
  return data[LAST_VIEWED_KEY] || null;
}

// Called when a tab navigates to a conversation -- a click, a reload, or a
// direct load. Nothing else may call this: a fetch alone must not change what
// the popup shows, which is what made hovering the sidebar swap the transcript.
async function markConversationViewed(uuid) {
  if (!uuid) {
    return;
  }
  // A single navigation produces several tab events; writing only on an actual
  // change keeps those from becoming a burst of storage notifications.
  if (await getLastViewedUuid() !== uuid) {
    await chrome.storage.local.set({ [LAST_VIEWED_KEY]: uuid });
  }

  const entry = await getConversation(uuid);
  if (entry && !entry.viewedAt) {
    entry.viewedAt = new Date().toISOString();
    await chrome.storage.local.set({ [conversationKey(uuid)]: entry });
  }
}

// What the popup should display for a given tab: the conversation on screen,
// or else the one last navigated to. Deliberately never "the most recently
// cached", which is precisely what a hover prefetch updates.
async function resolveDisplayConversation(tabUrl) {
  const tabUuid = conversationUuidFromPageUrl(tabUrl);
  const uuid = tabUuid || await getLastViewedUuid();
  return {
    uuid: uuid,
    fromTab: Boolean(tabUuid),
    entry: uuid ? await getConversation(uuid) : null
  };
}

// Drop anything past the cache limit or beyond the maximum age. Called after
// every write so the cache cannot grow without bound between cleanup alarms.
//
// Two rules beyond plain recency: the conversation currently being displayed is
// never evicted, and conversations that were only ever prefetched are evicted
// before ones the user actually opened.
async function pruneConversations() {
  const entries = await getAllConversations();
  const lastViewed = await getLastViewedUuid();
  const protectedKey = lastViewed ? conversationKey(lastViewed) : null;
  const now = Date.now();
  const stale = [];
  const keep = [];

  entries.forEach((item) => {
    if (item.key === protectedKey) {
      keep.push(item);
      return;
    }
    const age = now - Date.parse(item.entry.timestamp);
    if (!(age < CONVERSATION_MAX_AGE_MS)) {
      stale.push(item.key);
      return;
    }
    keep.push(item);
  });

  if (keep.length > CONVERSATION_CACHE_LIMIT) {
    const excess = keep.length - CONVERSATION_CACHE_LIMIT;
    const evictable = keep.filter((item) => item.key !== protectedKey);
    evictable.sort((a, b) => {
      const aViewed = a.entry.viewedAt ? 1 : 0;
      const bViewed = b.entry.viewedAt ? 1 : 0;
      if (aViewed !== bViewed) {
        return aViewed - bViewed;
      }
      return Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp);
    });
    evictable.slice(0, excess).forEach((item) => stale.push(item.key));
  }

  if (stale.length) {
    await chrome.storage.local.remove(stale);
  }
  return stale;
}

async function storeConversation(url, content) {
  const existing = await getConversation(content.uuid);
  const entry = {
    timestamp: new Date().toISOString(),
    url: url,
    content: content,
    // Preserved across refetches so a reloaded conversation keeps its standing
    // as one the user opened.
    viewedAt: existing ? (existing.viewedAt || null) : null
  };
  await chrome.storage.local.set({ [conversationKey(content.uuid)]: entry });
  await pruneConversations();
  return entry;
}
