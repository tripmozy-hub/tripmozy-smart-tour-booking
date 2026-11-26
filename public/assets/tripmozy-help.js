/* TripMozy Concierge Help Widget — Shared across all non-login pages */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__tmHelpLoaded) return;

  var pathname = (window.location && window.location.pathname) ? window.location.pathname : '';
  if (/^\/(login|signin|customer-login|customer\/login|vendor-login|vendor\/login|partner-login|partner\/login)(\.html)?\/?$/i.test(pathname)) {
    return;
  }

  window.__tmHelpLoaded = true;

  var HELPLINE_DISPLAY = '+91 96418 66181';
  var HELPLINE_TEL = '+919641866181';
  var SUPPORT_EMAIL = 'tripmozy@gmail.com';

  function injectStyles() {
    if (document.getElementById('tmHelpStyles')) return;
    var style = document.createElement('style');
    style.id = 'tmHelpStyles';
    style.textContent = [
      '#tmHelpRoot {',
      '  position: fixed;',
      '  right: 22px;',
      '  bottom: calc(20px + env(safe-area-inset-bottom, 0px));',
      '  z-index: 850;',
      '  font-family: "Plus Jakarta Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;',
      '  color: #14171C;',
      '  line-height: 1.45;',
      '}',
      '#tmHelpRoot * { box-sizing: border-box; }',
      '#tmHelpBtn {',
      '  display: inline-flex;',
      '  align-items: center;',
      '  gap: 8px;',
      '  padding: 11px 16px;',
      '  background: #14171C;',
      '  color: #F7F5F0;',
      '  border: 1px solid #9E6B30;',
      '  border-radius: 2px;',
      '  cursor: pointer;',
      '  font-family: inherit;',
      '  font-size: 13px;',
      '  font-weight: 600;',
      '  letter-spacing: 0.04em;',
      '  text-transform: uppercase;',
      '  box-shadow: 0 12px 30px rgba(17, 19, 23, 0.24);',
      '  transition: background 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;',
      '}',
      '#tmHelpBtn:hover {',
      '  background: #232730;',
      '  transform: translateY(-2px);',
      '  box-shadow: 0 16px 34px rgba(17, 19, 23, 0.30);',
      '}',
      '#tmHelpBtn:focus-visible {',
      '  outline: 2px solid #9E6B30;',
      '  outline-offset: 2px;',
      '}',
      '#tmHelpBtn svg {',
      '  color: #D4A962;',
      '  flex-shrink: 0;',
      '}',
      '#tmHelpPopover {',
      '  position: absolute;',
      '  right: 0;',
      '  bottom: calc(100% + 12px);',
      '  width: min(336px, calc(100vw - 28px));',
      '  background: #FFFFFF;',
      '  color: #14171C;',
      '  border: 1px solid #C9C2B4;',
      '  border-top: 3px solid #9E6B30;',
      '  border-radius: 2px;',
      '  box-shadow: 0 22px 48px rgba(17, 19, 23, 0.26);',
      '  overflow: hidden;',
      '  display: none;',
      '  text-align: left;',
      '}',
      '#tmHelpPopover.is-open {',
      '  display: block;',
      '  animation: tmHelpIn 0.2s cubic-bezier(0.22, 1, 0.36, 1) forwards;',
      '}',
      '@keyframes tmHelpIn {',
      '  from { opacity: 0; transform: translateY(8px); }',
      '  to { opacity: 1; transform: translateY(0); }',
      '}',
      '.tm-help-head {',
      '  padding: 15px 16px 12px;',
      '  background: #F7F5F0;',
      '  border-bottom: 1px solid #E2DDD3;',
      '  display: flex;',
      '  align-items: flex-start;',
      '  justify-content: space-between;',
      '  gap: 10px;',
      '}',
      '.tm-help-kicker {',
      '  font-family: "JetBrains Mono", ui-monospace, monospace;',
      '  font-size: 10px;',
      '  font-weight: 600;',
      '  letter-spacing: 0.14em;',
      '  text-transform: uppercase;',
      '  color: #7D5220;',
      '  margin-bottom: 3px;',
      '}',
      '.tm-help-title {',
      '  font-family: "Cormorant Garamond", Georgia, serif;',
      '  font-size: 21px;',
      '  font-weight: 600;',
      '  line-height: 1.15;',
      '  color: #14171C;',
      '  margin: 0;',
      '}',
      '.tm-help-close {',
      '  width: 28px;',
      '  height: 28px;',
      '  border: 1px solid #E2DDD3;',
      '  background: #FFFFFF;',
      '  color: #484E57;',
      '  border-radius: 2px;',
      '  cursor: pointer;',
      '  font-size: 16px;',
      '  line-height: 1;',
      '  display: inline-flex;',
      '  align-items: center;',
      '  justify-content: center;',
      '  flex-shrink: 0;',
      '}',
      '.tm-help-close:hover { background: #EFECE4; color: #14171C; }',
      '.tm-help-body { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }',
      '.tm-help-sub { font-size: 12.5px; color: #484E57; margin: 0 0 2px; }',
      '.tm-help-card {',
      '  border: 1px solid #E2DDD3;',
      '  background: #FDFCF9;',
      '  border-radius: 2px;',
      '  padding: 11px 12px;',
      '  display: flex;',
      '  align-items: center;',
      '  justify-content: space-between;',
      '  gap: 10px;',
      '}',
      '.tm-help-card-main { min-width: 0; flex: 1; }',
      '.tm-help-lbl {',
      '  font-family: "JetBrains Mono", ui-monospace, monospace;',
      '  font-size: 10px;',
      '  font-weight: 600;',
      '  text-transform: uppercase;',
      '  letter-spacing: 0.08em;',
      '  color: #767B84;',
      '  margin-bottom: 3px;',
      '}',
      '.tm-help-link {',
      '  display: inline-block;',
      '  color: #14171C;',
      '  text-decoration: none;',
      '  font-size: 14px;',
      '  font-weight: 700;',
      '  word-break: break-word;',
      '}',
      '.tm-help-link:hover { color: #7D5220; text-decoration: underline; }',
      '.tm-help-copy {',
      '  border: 1px solid #C9C2B4;',
      '  background: #FFFFFF;',
      '  color: #14171C;',
      '  border-radius: 2px;',
      '  padding: 6px 10px;',
      '  font-family: inherit;',
      '  font-size: 11px;',
      '  font-weight: 600;',
      '  cursor: pointer;',
      '  white-space: nowrap;',
      '  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;',
      '}',
      '.tm-help-copy:hover { background: #F6EFE6; border-color: #9E6B30; color: #7D5220; }',
      '.tm-help-copy.is-copied { background: #EBF3EF; border-color: #1B5E44; color: #1B5E44; }',
      '.tm-help-foot {',
      '  padding: 10px 16px 12px;',
      '  background: #F7F5F0;',
      '  border-top: 1px solid #E2DDD3;',
      '  font-size: 11px;',
      '  color: #767B84;',
      '}',
      '@media (max-width: 640px) {',
      '  #tmHelpRoot { right: 14px; bottom: calc(14px + env(safe-area-inset-bottom, 0px)); }',
      '  #tmHelpBtn { padding: 10px 14px; font-size: 12px; }',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  #tmHelpPopover.is-open { animation: none; }',
      '  #tmHelpBtn { transition: none; }',
      '}',
      '@media print {',
      '  #tmHelpRoot { display: none !important; }',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  function copyContact(text, btn) {
    if (!btn) return;
    var markCopied = function () {
      var prev = btn.textContent;
      btn.textContent = 'Copied';
      btn.classList.add('is-copied');
      setTimeout(function () {
        btn.textContent = prev || 'Copy';
        btn.classList.remove('is-copied');
      }, 1800);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(markCopied).catch(function () {
        fallbackCopy(text, markCopied);
      });
    } else {
      fallbackCopy(text, markCopied);
    }
  }

  function fallbackCopy(text, onDone) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      if (onDone) onDone();
    } catch (_) {}
  }

  function mountHelpWidget() {
    if (document.getElementById('tmHelpRoot') || !document.body) return;
    injectStyles();

    var root = document.createElement('div');
    root.id = 'tmHelpRoot';
    root.innerHTML = [
      '<div id="tmHelpPopover" role="dialog" aria-modal="false" aria-labelledby="tmHelpDialogTitle">',
      '  <div class="tm-help-head">',
      '    <div>',
      '      <div class="tm-help-kicker">TripMozy Concierge</div>',
      '      <h3 class="tm-help-title" id="tmHelpDialogTitle">Help &amp; Support Desk</h3>',
      '    </div>',
      '    <button type="button" class="tm-help-close" id="tmHelpCloseBtn" aria-label="Close help panel">&times;</button>',
      '  </div>',
      '  <div class="tm-help-body">',
      '    <p class="tm-help-sub">Reach our India tour &amp; escrow desk directly for booking assistance or operator coordination:</p>',
      '    <div class="tm-help-card">',
      '      <div class="tm-help-card-main">',
      '        <div class="tm-help-lbl">Helpline Number</div>',
      '        <a class="tm-help-link" href="tel:' + HELPLINE_TEL + '">' + HELPLINE_DISPLAY + '</a>',
      '      </div>',
      '      <button type="button" class="tm-help-copy" data-copy="' + HELPLINE_DISPLAY + '">Copy</button>',
      '    </div>',
      '    <div class="tm-help-card">',
      '      <div class="tm-help-card-main">',
      '        <div class="tm-help-lbl">Official Gmail</div>',
      '        <a class="tm-help-link" href="mailto:' + SUPPORT_EMAIL + '?subject=TripMozy%20Support">' + SUPPORT_EMAIL + '</a>',
      '      </div>',
      '      <button type="button" class="tm-help-copy" data-copy="' + SUPPORT_EMAIL + '">Copy</button>',
      '    </div>',
      '  </div>',
      '  <div class="tm-help-foot">Booking Escrow · GST Receipts · 24/7 Tour Support</div>',
      '</div>',
      '<button type="button" id="tmHelpBtn" aria-expanded="false" aria-controls="tmHelpPopover" aria-label="Open TripMozy Help & Support">',
      '  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">',
      '    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>',
      '  </svg>',
      '  <span>Help</span>',
      '</button>'
    ].join('\n');

    document.body.appendChild(root);

    var btn = document.getElementById('tmHelpBtn');
    var popover = document.getElementById('tmHelpPopover');
    var closeBtn = document.getElementById('tmHelpCloseBtn');

    function setOpen(open) {
      if (!popover || !btn) return;
      if (open) {
        popover.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
      } else {
        popover.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
      }
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!popover.classList.contains('is-open'));
    });

    closeBtn.addEventListener('click', function () {
      setOpen(false);
      btn.focus();
    });

    popover.querySelectorAll('.tm-help-copy').forEach(function (copyBtn) {
      copyBtn.addEventListener('click', function () {
        copyContact(copyBtn.getAttribute('data-copy') || '', copyBtn);
      });
    });

    document.addEventListener('click', function (e) {
      if (!root.contains(e.target) && popover.classList.contains('is-open')) {
        setOpen(false);
      }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && popover.classList.contains('is-open')) {
        setOpen(false);
        btn.focus();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountHelpWidget);
  } else {
    mountHelpWidget();
  }
})();
