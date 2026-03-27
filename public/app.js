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
