
function setLang(lang) {
    localStorage.setItem("lang", lang);
    applyLang();
}

function applyLang() {
    const lang = localStorage.getItem("lang") || "en";

    document.body.classList.remove("lang-en-active", "lang-es-active");
    document.body.classList.add(`lang-${lang}-active`);
}

document.addEventListener("DOMContentLoaded", applyLang);
