// Inline no-flash script run before paint. Sets the display attributes on
// <html> from saved preferences so the first frame is already right:
//   data-theme    dark (default) | light
//   data-contrast more | normal — saved "more"/"normal" wins; otherwise the
//                 OS setting (prefers-contrast: more) decides
//   data-density  comfortable (default) | compact
//   data-mode     pal | runtime — the space whose accent applies. Decided by
//                 the route (same prefix lists as lib/workspace-nav); /settings
//                 keeps the remembered space; other routes get no space.
// Keys + values are shared with lib/display-prefs.ts and use-workspace-mode.
// The prefix lists are copied, not imported (this string must stay standalone);
// theme-state.test.mts fails if they drift from lib/workspace-nav.
export const INIT_RUNTIME_PREFIXES = [
  "/overview", "/agents", "/runs", "/inbox", "/runtime", "/deployments", "/eval-suites",
  "/evaluations", "/experiments", "/budgets", "/connectors", "/surfaces", "/embed", "/marketplace",
];
export const INIT_PAL_PREFIXES = ["/brief", "/personal", "/automations", "/voice", "/pal"];

export const THEME_INIT_SCRIPT = `try{var d=document.documentElement,s=localStorage,t=s.getItem('pal-theme')||'dark',c=s.getItem('pal-contrast'),n=s.getItem('pal-density');d.dataset.theme=t;d.dataset.contrast=(c==='more'||c==='normal')?c:((typeof matchMedia==='function'&&matchMedia('(prefers-contrast: more)').matches)?'more':'normal');d.dataset.density=n==='compact'?'compact':'comfortable';var p=location.pathname,u=function(a){return a.some(function(x){return p===x||p.indexOf(x+'/')===0})},m=u(${JSON.stringify(INIT_RUNTIME_PREFIXES)})?'runtime':u(${JSON.stringify(INIT_PAL_PREFIXES)})?'pal':u(['/settings'])?(s.getItem('pal-mode')==='runtime'?'runtime':'pal'):'';if(m)d.dataset.mode=m;}catch(e){document.documentElement.dataset.theme='dark';}`;
