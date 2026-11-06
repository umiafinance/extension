const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (value) => String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

export const mark = (mood, size) =>
  `<div class="umia-mark" data-mood="${mood}" style="--mark-size:${size}px" aria-hidden="true"></div>`;
