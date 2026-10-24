/** Shared with utils/theme.ts, which writes the viewer's choice. Kept free of React so the root
 * layout (a server component) can import the script below. */
export const THEME_STORAGE_KEY = "clio-visualizer-theme";

/**
 * Inlined in <head> so the right theme is applied before first paint. Order: the `__theme` query
 * param (HF Spaces passes the Hub's theme to the embedded app that way), then the viewer's own
 * choice, then Clio’s light default.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var q=new URLSearchParams(location.search).get("__theme");var s=null;try{s=localStorage.getItem("${THEME_STORAGE_KEY}")}catch(e){}var t=q==="light"||q==="dark"?q:s==="light"||s==="dark"?s:"light";document.documentElement.classList.toggle("dark",t==="dark")}catch(e){}})()`;
