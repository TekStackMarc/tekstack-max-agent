(function () {
  'use strict';

  // Hardcoded fallback in case data-max-url attribute is stripped by WordPress/WPEngine
  const FALLBACK_URL = 'https://tekstack-max-agent-production.up.railway.app';
  const scriptEl = document.currentScript || document.querySelector('script[data-max-url]');
  const BASE_URL = (scriptEl && scriptEl.getAttribute('data-max-url')) || FALLBACK_URL;

  // ── Session tracking ──
  const VISIT_COUNT_KEY = 'max_page_count';
  const AUTO_SHOWN_KEY  = 'max_auto_shown';
  const EXIT_SHOWN_KEY  = 'max_exit_shown';

  let visitCount = parseInt(sessionStorage.getItem(VISIT_COUNT_KEY) || '0', 10) + 1;
  sessionStorage.setItem(VISIT_COUNT_KEY, String(visitCount));

  const SESSION_ID = sessionStorage.getItem('max_session_id') || (() => {
    const id = genId(); sessionStorage.setItem('max_session_id', id); return id;
  })();
  let CONVERSATION_ID = genId();

  // ── Config (loaded from server) ──
  let config = { timer_first_page: 20, booking_url: '', agent_name: 'Max' };

  // ── State ──
  let isOpen = false;
  let isStreaming = false;
  let bookingPending = false;
  let currentBubble = null;
  let currentBubbleText = '';

  function genId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  // ── Flash prevention ──
  // Hide the entire widget root until CSS is loaded, then let CSS take over
  function injectCriticalStyle() {
    const s = document.createElement('style');
    s.id = 'max-critical-style';
    s.textContent = '#max-widget-root{display:none!important}';
    document.head.insertBefore(s, document.head.firstChild);
  }

  function injectStyles() {
    if (document.getElementById('max-widget-styles')) return;
    const link = document.createElement('link');
    link.id = 'max-widget-styles';
    link.rel = 'stylesheet';
    link.href = BASE_URL + '/static/widget.css';
    // Once CSS loads (or fails), remove critical style and show widget root
    link.onload = link.onerror = function () {
      const root = document.getElementById('max-widget-root');
      if (root) root.style.display = 'block';
      const crit = document.getElementById('max-critical-style');
      if (crit) crit.remove();
    };
    document.head.appendChild(link);
  }

  // ── DOM ──
  function buildWidget() {
    const root = document.createElement('div');
    root.id = 'max-widget-root';
    root.innerHTML = `
      <button id="max-launcher" aria-label="Chat with Max">
        <span id="max-badge"></span>
        <svg class="icon-chat" width="26" height="26" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"/>
        </svg>
        <svg class="icon-close" width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="white" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
      <div id="max-window" style="display:none" role="dialog" aria-label="Max chat window">
        <div id="max-header">
          <div id="max-avatar">🤖</div>
          <div id="max-header-info">
            <div id="max-header-name">Max</div>
            <div id="max-header-status"><span id="max-status-dot"></span> TekStack Assistant</div>
          </div>
        </div>
        <div id="max-messages" role="log" aria-live="polite"></div>
        <div id="max-input-bar">
          <textarea id="max-input" rows="1" placeholder="Ask me anything about TekStack..." aria-label="Message Max"></textarea>
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

  function el(id) { return document.getElementById(id); }

  // ── Open/Close ──
  function openChat() {
    if (isOpen) return;
    isOpen = true;
    const win = el('max-window');
    win.classList.remove('closing');
    win.style.display = 'flex';
    el('max-launcher').classList.add('open');
    el('max-badge').classList.remove('visible');
    if (el('max-messages').children.length === 0) showGreeting();
    setTimeout(() => el('max-input').focus(), 200);
  }

  function closeChat() {
    if (!isOpen) return;
    isOpen = false;
    const win = el('max-window');
    win.classList.add('closing');
    el('max-launcher').classList.remove('open');
    setTimeout(() => { win.style.display = 'none'; win.classList.remove('closing'); }, 250);
  }

  function toggleChat() { isOpen ? closeChat() : openChat(); }

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
    if (!isOpen) el('max-badge').classList.add('visible');
  }

  function setInputDisabled(disabled) {
    el('max-input').disabled = disabled;
    el('max-send').disabled = disabled;
  }

  function showGreeting() {
    const name = config.agent_name || 'Max';
    const company = config.company_name || 'our company';
    addMessage('assistant',
      `Hi! 👋 I'm ${name}, ${company}'s AI assistant. I can answer questions about our products, ` +
      `help you find the right solution, or connect you with our team. What can I help you with today?`
    );
  }

  function applyBranding() {
    // Primary color — sets CSS variable used throughout the widget
    if (config.primary_color) {
      document.documentElement.style.setProperty('--max-primary', config.primary_color);
    }
    // Agent name
    const nameEl = document.getElementById('max-header-name');
    if (nameEl) nameEl.textContent = config.agent_name || 'Max';
    const btn = document.getElementById('max-launcher');
    if (btn) btn.setAttribute('aria-label', 'Chat with ' + (config.agent_name || 'Max'));
    // Company name in header subtitle
    const statusEl = document.getElementById('max-header-status');
    if (statusEl) {
      statusEl.innerHTML = `<span id="max-status-dot"></span> ${config.company_name || 'AI Assistant'}`;
    }
    // Footer
    const footer = document.getElementById('max-footer');
    if (footer) footer.textContent = `Powered by ${config.company_name || 'AI'} Assistant`;
  }

  // Keep old name as alias for backward compat
  function applyAgentName() { applyBranding(); }

  // ── Booking card ──
  function showBookingCard() {
    const container = el('max-messages');
    const card = document.createElement('div');
    card.id = 'max-booking-card';
    card.className = 'max-booking-card';
    card.innerHTML = `
      <p>📅 Pick a time that works for you — book directly with our team:</p>
      <a id="max-booking-btn" href="${config.booking_url}" target="_blank" rel="noopener">Book a Meeting →</a>
    `;
    card.style.cssText = 'margin:8px 0;padding:16px;background:#f0f7ff;border:1px solid #c7e0ff;border-radius:12px;display:flex;flex-direction:column;gap:10px;max-width:90%;';
    const p = card.querySelector('p');
    p.style.cssText = 'font-size:13px;color:#1a1a1a;line-height:1.5;margin:0;';
    const btn = card.querySelector('a');
    btn.style.cssText = 'padding:10px 16px;background:#0052cc;color:white;border-radius:8px;font-size:13px;font-weight:500;font-family:Montserrat,sans-serif;text-decoration:none;text-align:center;transition:background 0.15s;display:inline-block;';
    btn.onmouseover = () => btn.style.background = '#0041a8';
    btn.onmouseout = () => btn.style.background = '#0052cc';
    container.appendChild(card);
    scrollToBottom();
  }

  // ── Chat ──
  function sendMessage(text) {
    if (!text.trim() || isStreaming) return;
    isStreaming = true;
    bookingPending = false;
    addMessage('user', text);
    el('max-input').value = '';
    el('max-input').style.height = 'auto';
    setInputDisabled(true);
    addTypingIndicator();

    fetch(BASE_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: CONVERSATION_ID,
        session_id: SESSION_ID,
        message: text,
        page_url: window.location.href,
      }),
    }).then(response => {
      if (!response.ok) throw new Error('API error ' + response.status);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      currentBubble = null;
      currentBubbleText = '';

      function processBuffer() {
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try { handleSSEEvent(JSON.parse(line.slice(6))); } catch (_) {}
        }
      }

      function read() {
        reader.read().then(({ done, value }) => {
          if (done) { finishStreaming(); return; }
          buffer += decoder.decode(value, { stream: true });
          processBuffer();
          read();
        }).catch(() => { finishStreaming(); });
      }
      read();
    }).catch(() => {
      removeTypingIndicator();
      addMessage('assistant', 'Sorry, I ran into a problem. Please try again.');
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
        bookingPending = true;
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
    if (bookingPending) {
      showBookingCard();
      bookingPending = false;
    }
  }

  // ── Page tracking ──
  function trackPage() {
    fetch(BASE_URL + '/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: SESSION_ID,
        url: window.location.href,
        title: document.title,
      }),
    }).catch(() => {});
  }

  // ── Exit intent ──
  function setupExitIntent() {
    if (sessionStorage.getItem(EXIT_SHOWN_KEY)) return;
    // Wait 5s before activating so it doesn't fire immediately on page load
    setTimeout(() => {
    document.addEventListener('mouseleave', function onLeave(e) {
      if (e.clientY <= 0 && !isOpen) {
        sessionStorage.setItem(EXIT_SHOWN_KEY, '1');
        document.removeEventListener('mouseleave', onLeave);
        openChat();
        showBadge();
        if (el('max-messages').children.length <= 1) {
          setTimeout(() => {
            addMessage('assistant', "Before you go — got any questions about TekStack? I'm happy to help! 😊");
          }, 400);
        }
      }
    });
    }, 5000); // 5s grace period before exit intent activates
  }

  // ── Auto-open timer ──
  async function loadConfigAndSchedule() {
    try {
      const res = await fetch(BASE_URL + '/api/config');
      if (res.ok) config = await res.json();
    } catch (_) {}

    // Apply branding (color, name, company)
    applyBranding();

    // Auto-open: use timer_first_page for all visits; 0 = disabled
    if (sessionStorage.getItem(AUTO_SHOWN_KEY)) return;
    const delay = config.timer_first_page > 0 ? (config.timer_first_page * 1000) : null;
    if (delay === null) return; // timer disabled
    setTimeout(() => {
      if (!isOpen) {
        openChat();
        showBadge();
        sessionStorage.setItem(AUTO_SHOWN_KEY, '1');
      }
    }, delay);
  }

  // ── Input auto-resize ──
  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  // ── Events ──
  function attachEvents() {
    el('max-launcher').addEventListener('click', toggleChat);
    el('max-send').addEventListener('click', () => sendMessage(el('max-input').value));
    el('max-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(e.target.value); }
    });
    el('max-input').addEventListener('input', e => autoResize(e.target));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) closeChat(); });
  }

  // ── Init ──
  function init() {
    injectCriticalStyle();
    injectStyles();
    buildWidget();
    attachEvents();
    trackPage();
    loadConfigAndSchedule();
    setupExitIntent();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
