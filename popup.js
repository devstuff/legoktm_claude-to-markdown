// SPDX-License-Identifier: Apache-2.0
document.addEventListener('DOMContentLoaded', function() {
    const title = document.getElementById('jsonTitle');
    const textArea = document.getElementById('jsonContent');
    const timestampDiv = document.getElementById('timestamp');
    const refreshButton = document.getElementById('refreshButton');
    const gistButton = document.getElementById('gistButton');
    const settingsButton = document.getElementById('settingsButton');
    const statusDiv = document.getElementById('status');
    const claudeIdDiv = document.getElementById('claude-id');
    const windowButton = document.getElementById('windowButton');

    // One page serves both the toolbar panel and the detached window; the query
    // parameter is what tells them apart.
    const isWindowed = new URLSearchParams(location.search).has('windowed');

    // The smallest size that still shows everything without scrolling, with room
    // to spare: the layout's own floors are lower still (see popup.css), so
    // dragging somewhat below this stays scroll-free too.
    const WINDOW_MIN_WIDTH = 500;
    const WINDOW_MIN_HEIGHT = 350;
    const WINDOW_DEFAULT_WIDTH = 900;
    const WINDOW_DEFAULT_HEIGHT = 700;
    const WINDOW_GEOMETRY_KEY = 'windowGeometry';

    // The conversation being displayed: the one on the active tab, or the one
    // last navigated to when the tab is not a conversation page. Following
    // whatever arrived most recently instead is what made hovering the sidebar
    // swap the transcript out from under you.
    let displayedUuid = null;
    let tabConversationUuid = null;

    async function updateContent(entry) {
      const content = entry && entry.content;
      dlog("popup.updateContent", {
        hasEntry: Boolean(entry),
        tabUuid: c2mdShortUuid(tabConversationUuid),
        uuid: c2mdShortUuid(content && content.uuid),
        name: content && typeof content.name === "string" ? content.name.slice(0, 48) : null,
        msgs: content && Array.isArray(content.chat_messages)
          ? content.chat_messages.length
          : (content && "chat_messages" in content ? "NOT_ARRAY" : "KEY_ABSENT")
      });

      if (entry) {
        title.value = content.name;
        let markdown;
        try {
          markdown = buildMarkdown(content);
        } catch (e) {
          dlog("popup.buildMarkdownThrew", { error: String(e), stack: String(e && e.stack).slice(0, 400) });
          throw e;
        }
        dlog("popup.rendered", {
          uuid: c2mdShortUuid(content.uuid),
          markdownLength: markdown.length,
          blank: markdown.trim().length === 0
        });
        textArea.value = markdown;
        timestampDiv.textContent = `Last updated: ${new Date(entry.timestamp).toLocaleString()}`;
        claudeIdDiv.textContent = content.uuid;
        if (await getGistId(content.uuid)) {
          gistButton.textContent = 'Update Gist';
        } else {
          gistButton.textContent = 'Create Gist';
        }
      } else {
        title.value = '';
        textArea.value = tabConversationUuid
          ? 'This conversation has not been loaded yet. Click Refresh Page.'
          : 'No conversation opened yet.';
        timestampDiv.textContent = '';
        claudeIdDiv.textContent = '';
        gistButton.textContent = 'Create Gist';
      }
    }

    // In the panel, the active tab is the Claude tab. In the detached window the
    // active tab is this page itself, so the Claude tab has to be looked for
    // among ordinary browser windows instead.
    async function findTargetTab() {
      if (!isWindowed) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        return tabs[0] || null;
      }
      const tabs = await chrome.tabs.query({ active: true, windowType: 'normal' });
      return tabs.find((tab) => conversationUuidFromPageUrl(tab.url))
        || tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith('https://claude.ai/'))
        || null;
    }

    // Size is remembered; position deliberately is not. A position saved on one
    // display can land where no screen exists on another, and an extension page
    // cannot enumerate displays to check, so Firefox is left to place it.
    async function saveWindowSize() {
      const size = { width: window.outerWidth, height: window.outerHeight };
      await chrome.storage.local.set({ [WINDOW_GEOMETRY_KEY]: size });
      dlog('window.sizeSaved', size);
    }

    async function openInWindow() {
      const data = await chrome.storage.local.get(WINDOW_GEOMETRY_KEY);
      const saved = data[WINDOW_GEOMETRY_KEY] || {};
      const created = await chrome.windows.create({
        url: chrome.runtime.getURL('popup.html?windowed=1'),
        type: 'popup',
        width: Math.max(WINDOW_MIN_WIDTH, Number(saved.width) || WINDOW_DEFAULT_WIDTH),
        height: Math.max(WINDOW_MIN_HEIGHT, Number(saved.height) || WINDOW_DEFAULT_HEIGHT)
      });
      dlog('window.opened', { id: created && created.id });
      // The panel has been replaced by the window it just opened.
      window.close();
    }

    // Prefer the conversation on screen; otherwise the one last navigated to,
    // so opening the popup from the conversation list still shows the chat you
    // were last reading rather than whichever entry the pointer crossed.
    async function loadContentForActiveTab(tabUrl) {
      const resolved = await resolveDisplayConversation(tabUrl);
      displayedUuid = resolved.uuid;
      tabConversationUuid = resolved.fromTab ? resolved.uuid : null;
      dlog("popup.resolved", {
        uuid: c2mdShortUuid(resolved.uuid),
        fromTab: resolved.fromTab,
        cached: Boolean(resolved.entry)
      });
      await updateContent(resolved.entry);
    }

    function showStatus(message, isError = false) {
      statusDiv.textContent = message;
      statusDiv.className = `show ${isError ? 'error' : 'success'}`;
      setTimeout(() => {
        statusDiv.className = 'hide';
      }, 5000);
    }

    async function createGist(claudeId, gistId, name, content, token) {
      let method = 'POST';
      let url = 'https://api.github.com/gists';
      if (gistId) {
        url = `https://api.github.com/gists/${gistId}`;
        method = 'PATCH';
      }
      const response = await fetch(url, {
        method: method,
        headers: {
          'Authorization': `token ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          description: name,
          public: false,
          files: {
            [`claude_chat_${claudeId}.md`]: {
              content: content,
            }
          }
        })
      });

      if (!response.ok) {
        throw new Error(`GitHub API responded with ${response.status}`);
      }

      return await response.json();
    }

    async function storeGistId(claudeId, gistId) {
      const item = {
        value: gistId,
        expiry: Date.now() + (30 * 24 * 60 * 60 * 1000) // 30 days
      };
      await chrome.storage.local.set({ [`gist-${claudeId}`]: item });
    }

    async function getGistId(claudeId) {
      const key = `gist-${claudeId}`;
      const data = await chrome.storage.local.get(key);

      if (data[key]) {
        return data[key].value;
      } else {
        return null;
      }
    }

    async function loadContentFromTarget() {
      const tab = await findTargetTab();
      const tabUrl = tab ? tab.url : null;
      const tabUuid = conversationUuidFromPageUrl(tabUrl);
      dlog("popup.opened", {
        windowed: isWindowed,
        tabUrl: tabUrl ? c2mdShortUrl(tabUrl) : null,
        tabUuid: c2mdShortUuid(tabUuid)
      });
      // Covers a navigation the background script missed, such as one that
      // happened while its event page was suspended.
      if (tabUuid) {
        await markConversationViewed(tabUuid);
      }
      await loadContentForActiveTab(tabUrl);
    }

    // Load initial content and check for GitHub token
    loadContentFromTarget();

    if (isWindowed) {
      document.body.classList.add('windowed');
      // Nothing to open: this already is the window.
      windowButton.classList.add('hide');

      let sizeSaveTimer = null;
      window.addEventListener('resize', function() {
        clearTimeout(sizeSaveTimer);
        sizeSaveTimer = setTimeout(function() {
          saveWindowSize().catch((e) => dlog('window.sizeSaveFailed', { error: String(e) }));
        }, 400);
      });
    } else {
      windowButton.addEventListener('click', function() {
        openInWindow().catch(function(e) {
          dlog('window.openFailed', { error: String(e) });
          showStatus(`Could not open a window: ${e.message}`, true);
        });
      });
    }

    chrome.storage.local.get(['githubToken'], function(data) {
      if (data.githubToken) {
        gistButton.classList.add('show');
        gistButton.classList.remove('hide');
      }
    });

    // Listen for storage changes
    chrome.storage.onChanged.addListener(async function(changes, namespace) {
      // Only a change to the conversation being displayed may redraw the popup.
      // Hovering the sidebar writes other keys, and reacting to those is
      // exactly what replaced the transcript with a conversation the user never
      // opened. With nothing displayed, nothing is watched, so hovering over an
      // unopened conversation does nothing at all.
      const relevantKey = displayedUuid ? conversationKey(displayedUuid) : null;
      const relevantChange = relevantKey ? changes[relevantKey] : undefined;

      dlog("popup.storageChanged", {
        keys: Object.keys(changes),
        watching: relevantKey || null,
        redraw: Boolean(relevantChange)
      });

      if (relevantChange) {
        await updateContent(relevantChange.newValue || null);
      }
      // A detached window stays open while you carry on browsing, so it follows
      // the conversation you navigate to rather than pinning itself to whichever
      // one was open when it was created. Only navigation changes this key, so
      // hovering the sidebar still does nothing.
      if (isWindowed && changes[LAST_VIEWED_KEY]) {
        await loadContentFromTarget();
      }
      if (changes.githubToken) {
        if (changes.githubToken.newValue) {
          gistButton.classList.add('show');
          gistButton.classList.remove('hide');
        } else {
          gistButton.classList.remove('show');
          gistButton.classList.add('hide');
        }
      }
    });

    // Refresh button functionality
    refreshButton.addEventListener('click', async function() {
      // Reloads the Claude tab, which from the detached window is a tab in
      // another window rather than this page.
      const tab = await findTargetTab();
      dlog("popup.refreshClicked", {
        windowed: isWindowed,
        tabUrl: tab ? c2mdShortUrl(tab.url) : null
      });
      if (tab) {
        chrome.tabs.reload(tab.id);
      } else {
        showStatus('No Claude tab to reload.', true);
      }
    });

    // Settings button functionality
    settingsButton.addEventListener('click', function() {
        chrome.runtime.openOptionsPage();
    });

    // Gist button functionality
    gistButton.addEventListener('click', async function() {
      try {
        gistButton.disabled = true;

        // Get the token from storage
        const data = await new Promise(resolve => {
          chrome.storage.local.get('githubToken', resolve);
        });

        if (!data.githubToken) {
          throw new Error('GitHub token not configured');
        }

        const gistId = await getGistId(claudeIdDiv.textContent);
        const gistData = await createGist(
          claudeIdDiv.textContent,
          gistId,
          title.value,
          textArea.value,
          data.githubToken
        );
        await storeGistId(claudeIdDiv.textContent, gistData.id);
        showStatus(`Gist ${gistId ? 'updated' : 'created'} successfully! URL: ${gistData.html_url}`);
        chrome.tabs.create({ url: gistData.html_url });
      } catch (error) {
        showStatus(error.message, true);
      } finally {
        gistButton.disabled = false;
      }
    });
  });

function buildMarkdown(parsed) {
    if (!parsed.chat_messages) {
        return "";
    }
    const bits = [];
    bits.push(`# ${parsed.name}`);
    parsed.chat_messages.forEach((message) => {
        bits.push(
        `**${message.sender}** (${new Date(message.created_at).toLocaleString(
            "en-US",
            {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
            }
        )})`
        );
        message.content.forEach((content) => {
        if (content.type == "thinking") {
            // Skip internal reasoning blocks — not part of the visible conversation.
            return;
        } else if (content.type == "tool_use") {
            if (content.name == "repl") {
            bits.push(
                "**Analysis**\n```" +
                `javascript\n${content.input.code.trim()}` +
                "\n```"
            );
            } else if (content.name == "artifacts") {
            let lang =
                content.input.language || typeLookup[content.input.type] || "";
            // It's an artifact, but is it a create/rewrite/update?
            const input = content.input;
            if (input.command == "create" || input.command == "rewrite") {
                bits.push(
                `#### ${input.command} ${
                    content.input.title || "Untitled"
                }\n\n\`\`\`${lang}\n${content.input.content}\n\`\`\``
                );
            } else if (input.command == "update") {
                bits.push(
                `#### update ${content.input.id}\n\nFind this:\n\`\`\`\n${content.input.old_str}\n\`\`\`\nReplace with this:\n\`\`\`\n${content.input.new_str}\n\`\`\``
                );
            }
            }
            // Other tool_use types (web_search, web_fetch, etc.) are silently skipped —
            // their results are tool infrastructure, not conversation content.
        } else if (content.type == "tool_result") {
            if (content.name == "repl") {
            // Legacy analysis tool: result is JSON with a .logs array.
            try {
                let logs = JSON.parse(content.content[0].text).logs;
                bits.push(
                `**Result**\n<pre style="white-space: pre-wrap">\n${logs.join(
                    "\n"
                )}\n</pre>`
                );
            } catch (e) {
                // Ignore malformed repl results rather than crashing.
            }
            }
            // All other tool results (web_search, web_fetch, artifacts, etc.) are skipped —
            // they are raw data consumed by the model, not readable conversation text.
        } else if (content.type == "text") {
            if (content.text && content.text.trim()) {
            bits.push(
                replaceArtifactTags(
                content.text.replace(/<\/antArtifact>/g, "\n```")
                )
            );
            }
        } else {
            // Unknown content type: surface it only if it carries a text field.
            if (content.text) {
            bits.push(
                replaceArtifactTags(
                content.text.replace(/<\/antArtifact>/g, "\n```")
                )
            );
            }
        }
        });
        const backtick = String.fromCharCode(96);
        message.attachments.forEach((attachment) => {
        bits.push(`<details><summary>${attachment.file_name}</summary>`);
        bits.push("\n\n");
        bits.push(backtick.repeat(5));
        bits.push(attachment.extracted_content);
        bits.push(backtick.repeat(5));
        bits.push("</details>");
        });
    });
    return bits.join("\n\n");
}

function replaceArtifactTags(input) {
    // Regular expression to match <antArtifact> tags
    const regex = /<antArtifact[^>]*>/g;

    // Function to extract attributes from a tag string
    function extractAttributes(tag) {
      const attributes = {};
      const attrRegex = /(\w+)=("([^"]*)"|'([^']*)')/g;
      let match;
      while ((match = attrRegex.exec(tag)) !== null) {
        const key = match[1];
        const value = match[3] || match[4]; // Use either double or single quotes
        attributes[key] = value;
      }
      return attributes;
    }

    return input.replace(regex, (match) => {
      const attributes = extractAttributes(match);
      // Determine language based on 'language' attribute, otherwise fallback logic
      const lang = attributes.language || typeLookup[attributes.type] || "";

      // Return the Markdown formatted string
      return `### ${attributes.title || "Untitled"}\n\n\`\`\`${lang}`;
    });
}

typeLookup = {
    "application/vnd.ant.react": "jsx",
    "text/html": "html"
};
