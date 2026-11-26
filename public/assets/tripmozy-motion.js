// ============================================================================
// TripMozy Editorial Motion System
// Lightweight IntersectionObserver reveals & selective scroll parallax
// Respects prefers-reduced-motion accessibility preferences
// ============================================================================
(function () {
  const prefersReduced =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function revealAllImmediately() {
    document.querySelectorAll('[data-reveal]').forEach((el) => {
      el.classList.add('is-visible');
    });
  }

  function initReveals() {
    const items = Array.from(document.querySelectorAll('[data-reveal]'));
    if (!items.length) return;

    if (prefersReduced || !('IntersectionObserver' in window)) {
      revealAllImmediately();
      return;
    }

    function checkVisibleNow() {
      const vh = window.innerHeight || document.documentElement.clientHeight || 900;
      document.querySelectorAll('[data-reveal]:not(.is-visible)').forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.top < vh + 80) {
          el.classList.add('is-visible');
        }
      });
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const delay = entry.target.getAttribute('data-reveal-delay');
            if (delay) {
              entry.target.style.transitionDelay = delay + 'ms';
            }
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.01, rootMargin: '80px 0px 80px 0px' }
    );

    items.forEach((el) => observer.observe(el));

    // Continuous viewport sweep so fast programmatic/user scrolling never leaves passed sections dim
    let sweepTick = false;
    const onSweep = () => {
      if (!sweepTick) {
        sweepTick = true;
        window.requestAnimationFrame(() => {
          checkVisibleNow();
          sweepTick = false;
        });
      }
    };
    window.addEventListener('scroll', onSweep, { passive: true });
    window.addEventListener('resize', onSweep, { passive: true });
    checkVisibleNow();
    setTimeout(checkVisibleNow, 150);
    setTimeout(checkVisibleNow, 650);
  }

  function initParallax() {
    if (prefersReduced) return;
    const targets = Array.from(document.querySelectorAll('[data-parallax]'));
    if (!targets.length) return;

    let ticking = false;
    function update() {
      const scrollY = window.scrollY || window.pageYOffset || 0;
      const isMobile = window.innerWidth < 768;
      targets.forEach((el) => {
        const speed = parseFloat(el.getAttribute('data-parallax-speed') || '0.12');
        const effectiveSpeed = isMobile ? speed * 0.45 : speed;
        const rect = el.getBoundingClientRect();
        if (rect.bottom > -100 && rect.top < window.innerHeight + 200) {
          const offset = Math.round(scrollY * effectiveSpeed * 10) / 10;
          el.style.transform = `translate3d(0, ${offset}px, 0)`;
        }
      });
      ticking = false;
    }

    window.addEventListener(
      'scroll',
      () => {
        if (!ticking) {
          window.requestAnimationFrame(update);
          ticking = true;
        }
      },
      { passive: true }
    );
  }

  window.tmObserveReveals = initReveals;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.classList.add('tm-ready');
      initReveals();
      initParallax();
    });
  } else {
    document.documentElement.classList.add('tm-ready');
    initReveals();
    initParallax();
  }
})();
