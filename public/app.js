const select = document.querySelector("select[name='country_code']");
const preview = document.querySelector("#selected-flag");

if (select && preview) {
  const updatePreview = () => {
    const option = select.options[select.selectedIndex];
    const url = option?.dataset?.flagUrl || "";
    if (url) {
      preview.src = url;
      preview.style.visibility = "visible";
    } else {
      preview.removeAttribute("src");
      preview.style.visibility = "hidden";
    }
  };

  updatePreview();
  select.addEventListener("change", updatePreview);
}

const preserveScrollRoot = document.body?.dataset?.preserveScroll === "true";
if (preserveScrollRoot) {
  const storageKey = `scroll:${location.pathname}${location.search}`;

  const stored = sessionStorage.getItem(storageKey);
  if (stored !== null) {
    const y = Number(stored);
    sessionStorage.removeItem(storageKey);
    if (Number.isFinite(y)) {
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  }

  document.addEventListener("submit", () => {
    sessionStorage.setItem(storageKey, String(window.scrollY));
  });

  document.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link) {
      return;
    }
    if (link.getAttribute("target") === "_blank") {
      return;
    }
    const href = link.getAttribute("href") || "";
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) {
      return;
    }
    sessionStorage.setItem(storageKey, String(window.scrollY));
  });
}
