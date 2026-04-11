/**
 * TekStack Max Chat Widget
 * Drop this on your WordPress site via Insert Headers and Footers:
 *   <script src="https://YOUR-BACKEND-URL/static/widget.js" data-max-url="https://YOUR-BACKEND-URL"></script>
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const scriptEl = document.currentScript || document.querySelector('script[data-max-url]');
  const BASE_URL = (scriptEl && scriptEl.getAttribute('data-max-url')) || '';
  const FIRST_PAGE_DELAY_MS = 20000;   // 20 seconds on first page
  const SECOND_PAGE_DELAY_MS = 10000;  // 10 seconds on second page

  // ── Session tracking ────────────────────────────────────────────────────────
  const VISIT_COUNT_KEY = 'max_page_count';
  const AUTO_SHOWN_KEY  = 'max_auto_shown';

  let visitCount = parseInt(sessionStorage.getItem(VISIT_COUNT_KEY) || '0', 10) + 1;
  sessionStorage.setItem(VISIT_COUNT_KEY, String(visitCount));

  // ── Conversation identity ───────────────────────────────────────────────────
  function genId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  const SESSION_ID = sessionStorage.getItem('max_session_id') || (() => {
    const id = genId();
    sessionStorage.setItem('max_session_id', id);
    return id;
  })();

  let CONVERSATION_ID = genId(); // fresh per page load

  // ── State ───────────────────────────────────────────────────────────────────
  let isOpen = false;
  let isStreaming = false;
  let leadFormPending = false;
  let currentBubble = null;
  let currentBubbleText = '';

  // ── Build DOM ────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('max-widget-styles')) return;
    const link = document.createElement('link');
    link.id = 'max-widget-styles';
    link.rel = 'stylesheet';
    link.href = BASE_URL + '/static/widget.css';
    document.head.appendChild(link);
  }

  function buildWidget() {
    const root = document.createElement('div');
    root.id = 'max-widget-root';
    root.innerHTML = `
      <!-- Launcher button -->
      <button id="max-launcher" aria-label="Chat with Max">
        <span id="max-badge"></span>
        <svg class="icon-chat" width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
        </svg>
        <svg class="icon-close" width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2.5" style="opacity:0;position:absolute">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>

      <!-- Chat window -->
      <div id="max-window" class="hidden" role="dialog" aria-label="Max chat window">
        <!-- Header -->
        <div id="max-header">
          <div id="max-avatar">🤖</div>
          <div id="max-header-info">
            <div id="max-header-name">Max</div>
            <div id="max-header-status">
              <span id="max-status-dot"></span> TekStack Assistant
            </div>
          </div>
        </div>

        <!-- Messages -->
        <div id="max-messages" role="log" aria-live="polite"></div>

        <!-- Lead capture form (hidden by default) -->
        <div id="max-lead-form">
          <h3>Let's connect you with an expert 👋</h3>
          <div class="max-form-field">
            <label>Your name *</label>
            <input id="max-lead-name" type="text" placeholder="Jane Smith">
          </div>
          <div class="max-form-field">
            <label>Company *</label>
            <input id="max-lead-company" type="text" placeholder="Acme Corp">
          </div>
          <div class="max-form-field">
            <label>Work email *</label>
            <input id="max-lead-email" type="email" placeholder="jane@acme.com">
          </div>
          <div class="max-form-field">
            <label>Best time to reach you</label>
            <select id="max-lead-time">
              <option value="">— select —</option>
              <option>Morning (9am–12pm)</option>
              <option>Afternoon (12pm–5pm)</option>
              <option>Either works</option>
            </select>
          </div>
          <button id="max-lead-submit">Connect me with an expert →</button>
        </div>

        <!-- Input bar -->
        <div id="max-input-bar">
          <textarea
            id="max-input"
            rows="1"
            placeholder="Ask me anything about TekStack..."
            aria-label="Message Max"></textarea>
          <button id="max-send" aria-label="Send">
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
            </svg>
          </button>
        </div>

        <div id="max-footer">Powered by TekStack AI</div>
      </div>
    `;
    document.body.appendChild(root);
  }

  // ── UI helpers ──────────────────────────────────────────────────────────────
  function el(id) { return document.getElementById(id); }

  function openChat() {
    if (isOpen) return;
    isOpen = true;
    el('max-window').classList.remove('hidden');
    el('max-launcher').classList.add('open');
    el('max-badge').classList.remove('visible');
    if (el('max-messages').children.length === 0) {
      showGreeting();
    }
    setTimeout(() => el('max-input').focus(), 200);
  }

  function closeChat() {
    if (!isOpen) return;
    isOpen = false;
    el('max-window').classList.add('hidden');
    el('max-launcher').classList.remove('open');
  }

  function toggleChat() {
    isOpen ? closeChat() : openChat();
  }

  function addMessage(role, text) {
    const container = el('max-messages');
    const msgDiv = document.createElement('div');
    msgDiv.className = 'max-msg ' + role;
    const bubble = document.createElement('div');
    bubble.className = 'max-bubble';
    bubble.textContent = text;
    msgDiv.appendChild(bubble);
    container.appendChild(msgDiv);
    scrollToBottom();
    return bubble;
  }

  function addTypingIndicator() {
    const container = el('max-messages');
    const wrapper = document.createElement('div');
    wrapper.className = 'max-msg assistant';
    wrapper.id = 'max-typing-indicator';
    wrapper.innerHTML = '<div class="max-typing"><span></span><span></span><span></span></div>';
    container.appendChild(wrapper);
    scrollToBottom();
  }

  function removeTypingIndicator() {
    const t = el('max-typing-indicator');
    if (t) t.remove();
  }

  function scrollToBottom() {
    const c = el('max-messages');
    c.scrollTop = c.scrollHeight;
  }

  function showBadge() {
    if (!isOpen) {
      const badge = el('max-badge');
      badge.classList.add('visible');
    }
  }

  function setInputDisabled(disabled) {
    el('max-input').disabled = disabled;
    el('max-send').disabled = disabled;
  }

  // ── Greeting ─────────────────────────────────────────────────────────────────
  function showGreeting() {
    addMessage('assistant',
      "Hi! 👋 I'm Max, TekStack's AI assistant. I can answer questions about our products, " +
      "help you find the right solution, or connect you with our team. What can I help you with today?"
    );
  }

  // ── Streaming chat ────────────────────────────────────────────────────────────
  function sendMessage(text) {
    if (!text.trim() || isStreaming) return;
    isStreaming = true;
    leadFormPending = false;

    addMessage('user', text);
    el('max-input').value = '';
    el('max-input').style.height = 'auto';
    setInputDisabled(true);
    addTypingIndicator();

    const body = JSON.stringify({
      conversation_id: CONVERSATION_ID,
      session_id: SESSION_ID,
      message: text,
      page_url: window.location.href,
    });

    fetch(BASE_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then(response => {
      if (!response.ok) throw new Error('API error ' + response.status);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      currentBubble = null;
      currentBubbleText = '';

      function processBuffer() {
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            handleSSEEvent(event);
          } catch (_) { /* ignore parse errors */ }
        }
      }

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) {
            finishStreaming();
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          processBuffer();
          read();
        }).catch(err => {
          console.error('Stream error:', err);
          finishStreaming();
        });
      }

      read();
    }).catch(err => {
      console.error('Fetch error:', err);
      removeTypingIndicator();
      addMessage('assistant', 'Sorry, I ran into a problem. Please try again in a moment.');
      finishStreaming();
    });
  }

  function handleSSEEvent(event) {
    switch (event.type) {
      case 'text':
        removeTypingIndicator();
        if (!currentBubble) {
          const container = el('max-messages');
          const msgDiv = document.createElement('div');
          msgDiv.className = 'max-msg assistant';
          currentBubble = document.createElement('div');
          currentBubble.className = 'max-bubble';
          msgDiv.appendChild(currentBubble);
          container.appendChild(msgDiv);
        }
        currentBubbleText += event.content;
        currentBubble.textContent = currentBubbleText;
        scrollToBottom();
        break;

      case 'lead_form':
        leadFormPending = true;
        break;

      case 'done':
        finishStreaming();
        break;

      case 'error':
        removeTypingIndicator();
        addMessage('assistant', 'Sorry, something went wrong. Please try again.');
        finishStreaming();
        break;
    }
  }

  function finishStreaming() {
    isStreaming = false;
    currentBubble = null;
    currentBubbleText = '';
    removeTypingIndicator();
    setInputDisabled(false);
    el('max-input').focus();

    if (leadFormPending) {
      showLeadForm();
      leadFormPending = false;
    }
  }

  // ── Lead form ─────────────────────────────────────────────────────────────────
  function showLeadForm() {
    const form = el('max-lead-form');
    form.classList.add('visible');
    el('max-lead-name').focus();
    scrollToBottom();
  }

  function hideLeadForm() {
    el('max-lead-form').classList.remove('visible');
  }

  function submitLead() {
    const name = el('max-lead-name').value.trim();
    const company = el('max-lead-company').value.trim();
    const email = el('max-lead-email').value.trim();
    const time = el('max-lead-time').value;

    if (!name) { el('max-lead-name').focus(); return; }
    if (!company) { el('max-lead-company').focus(); return; }
    if (!email || !email.includes('@')) { el('max-lead-email').focus(); return; }

    const btn = el('max-lead-submit');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    fetch(BASE_URL + '/api/leads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: CONVERSATION_ID,
        name, company, email,
        preferred_time: time,
      }),
    }).then(() => {
      hideLeadForm();
      addMessage('assistant',
        `Thanks, ${name}! 🎉 Someone from the TekStack team will reach out to ${email} soon. ` +
        `In the meantime, feel free to ask me anything else!`
      );
      showBadge();
    }).catch(() => {
      btn.disabled = false;
      btn.textContent = 'Connect me with an expert →';
      addMessage('assistant', 'Hmm, there was an issue submitting your info. Please try again.');
    });
  }

  // ── Auto-open timer ───────────────────────────────────────────────────────────
  function scheduleAutoOpen() {
    if (sessionStorage.getItem(AUTO_SHOWN_KEY)) return;

    const delay = visitCount <= 1 ? FIRST_PAGE_DELAY_MS : SECOND_PAGE_DELAY_MS;
    setTimeout(() => {
      if (!isOpen) {
        openChat();
        showBadge();
        sessionStorage.setItem(AUTO_SHOWN_KEY, '1');
      }
    }, delay);
  }

  // ── Input auto-resize ─────────────────────────────────────────────────────────
  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  // ── Wire up events ────────────────────────────────────────────────────────────
  function attachEvents() {
    el('max-launcher').addEventListener('click', toggleChat);

    el('max-send').addEventListener('click', () => {
      sendMessage(el('max-input').value);
    });

    el('max-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage(e.target.value);
      }
    });

    el('max-input').addEventListener('input', e => autoResize(e.target));

    el('max-lead-submit').addEventListener('click', submitLead);

    // Close on Escape
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isOpen) closeChat();
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    buildWidget();
    attachEvents();
    scheduleAutoOpen();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
