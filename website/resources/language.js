urlLang = window.location.pathname.substr(5).replace(/([^\/]*)\/.*/,"$1");
filename = window.location.pathname.replace(/.*\//,"");

sel = document.getElementById("langSelect");
index = -1;
for(var o of sel.options) {
  if(o.value == urlLang)
    index = o.index;
}
sel.selectedIndex = index;

sel.addEventListener("change", function() {
  lang = sel.selectedOptions[0].value;
  window.location.replace("/www/" + lang + "/" + filename);
}, false);
