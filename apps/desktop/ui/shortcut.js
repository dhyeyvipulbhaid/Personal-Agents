document.addEventListener("keydown", (event) => {
  if (!event.altKey || event.key.toLowerCase() !== "c") {
    return;
  }
  if (
    location.pathname.endsWith("/chat.html") ||
    location.pathname.endsWith("\\chat.html")
  ) {
    return;
  }
  location.href = "chat.html";
});
