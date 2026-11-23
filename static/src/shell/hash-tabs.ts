/**
 * Hash navigation for the single-page build.
 *
 * A static file has no path routing, so the active main tab lives in the URL
 * hash instead: `#/90`, `#/180`, `#/highlights`, `#/holders`, `#/increases` or
 * `#/selected`. Deep links, reloads and the back button all keep working, and
 * the page also loads correctly from a plain file path.
 */

const TABS: Array<{ slug: string; label: string }> = [
  { slug: "90", label: "فیلتر ۹۰ روزه" },
  { slug: "180", label: "فیلتر ۱۸۰ روزه" },
  { slug: "highlights", label: "بیشترین‌های فهرست" },
  { slug: "holders", label: "حقیقی‌های عمده کل بازار" },
  { slug: "increases", label: "خرید حقیقی عمده" },
  { slug: "selected", label: "نمادهای منتخب" },
];

const normalize = (value: string) => value.replace(/[\u200c\u200f\ufeff\s]+/g, "");

export function installHashTabs() {
  let applying = false;
  let attempts = 0;

  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>(".tabs button"));

  const slugOf = (button: HTMLButtonElement) => {
    const text = normalize(button.textContent ?? "");
    const match = TABS.find((tab) => text.includes(normalize(tab.label)));
    return match ? match.slug : null;
  };

  const activeSlug = () => {
    const active = buttons().find((button) => button.classList.contains("active"));
    return active ? slugOf(active) : null;
  };

  const applyHash = () => {
    const slug = window.location.hash.replace(/^#\/?/, "").trim();
    if (!slug) return;
    const target = buttons().find((button) => slugOf(button) === slug);
    if (!target || target.classList.contains("active")) return;
    applying = true;
    target.click();
    window.setTimeout(() => {
      applying = false;
    }, 250);
  };

  const syncFromDom = () => {
    if (applying) return;
    const slug = activeSlug();
    if (!slug) return;
    const next = `#/${slug}`;
    if (window.location.hash === next) return;
    try {
      window.history.replaceState(null, "", next);
    } catch {
      window.location.hash = next;
    }
  };

  const attach = () => {
    const nav = document.querySelector<HTMLElement>(".tabs");
    if (!nav) return false;
    new MutationObserver(syncFromDom).observe(nav, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"],
    });
    return true;
  };

  // React mounts asynchronously; retry briefly instead of assuming a ready DOM.
  const waitForTabs = () => {
    if (attach()) {
      applyHash();
      syncFromDom();
      return;
    }
    attempts += 1;
    if (attempts < 40) window.setTimeout(waitForTabs, 100);
  };

  waitForTabs();
  window.addEventListener("hashchange", applyHash);
}
