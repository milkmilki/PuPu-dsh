/** Namespaced styles inherit the DSH theme and leave the host shell untouched. */
export const styles = `
.pn-root{--pn-border:var(--dsw-alias-border-l3,#ddd);--pn-muted:var(--dsw-alias-label-secondary,#666);--pn-bg:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#222);font:14px/1.6 system-ui,sans-serif;min-width:0;max-width:1200px;margin:auto}
.pn-root *{box-sizing:border-box}
.pn-root h1,.pn-root h2,.pn-root h3,.pn-root h4,.pn-root p{margin:0 0 12px}
.pn-root h1{font-size:22px;line-height:1.4;font-weight:650}
.pn-root h2{font-size:17px;line-height:1.5;font-weight:620}
.pn-root h3{font-size:15px;font-weight:620}
.pn-root h4{font-size:14px;font-weight:620}
.pn-root button,.pn-root input,.pn-root select,.pn-root textarea{font:inherit;color:inherit}
.pn-root button{cursor:pointer;border:1px solid var(--pn-border);border-radius:var(--dsw-radius-sm,5px);background:transparent;padding:5px 10px;line-height:1.5}
.pn-root button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f4f4f4)}
.pn-root button:disabled{cursor:default;opacity:.45}
.pn-root button:focus-visible,.pn-root input:focus-visible,.pn-root select:focus-visible,.pn-root textarea:focus-visible,.pn-root a:focus-visible{outline:2px solid var(--dsw-focus-ring-color,#21896e);outline-offset:2px}
.pn-root input,.pn-root select,.pn-root textarea{border:1px solid var(--pn-border);border-radius:var(--dsw-radius-sm,5px);background:var(--pn-bg);padding:7px 10px;min-width:0;max-width:100%}
.pn-root textarea{resize:vertical;line-height:1.7}
.pn-root label{display:flex;flex-direction:column;gap:5px;font-weight:500}
.pn-root fieldset{border:1px solid var(--pn-border);padding:16px;display:flex;flex-direction:column;gap:12px}
.pn-root legend{padding:0 6px}
.pn-root pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.65 ui-monospace,Consolas,monospace;max-width:100%;margin:8px 0;padding:12px;border:1px solid var(--pn-border);border-radius:5px}
.pn-root summary{cursor:pointer;overflow-wrap:anywhere}
.pn-page-header{padding:8px 0 16px;display:flex;gap:24px;justify-content:space-between;align-items:start}
.pn-page-header p{margin-bottom:0}
.pn-role-picker{min-width:160px}
.pn-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--pn-border);margin-bottom:16px}
.pn-tabs button{border:0;border-radius:0;padding:10px 14px;border-bottom:2px solid transparent}
.pn-tabs button[aria-current=page]{font-weight:650;border-bottom-color:var(--dsw-alias-label-primary,#222)}
.pn-page-body{display:flex;flex-direction:column;gap:28px}
.pn-section{padding:8px 0 24px;border-bottom:1px solid var(--pn-border)}
.pn-form{display:flex;flex-direction:column;align-items:stretch;gap:14px;max-width:760px;margin-top:20px}
.pn-form>button{align-self:start}
.pn-form p{margin:0}
.pn-row-form{display:flex;align-items:end;gap:12px;flex-wrap:wrap}
.pn-row-form>label{flex:1;min-width:180px}
.pn-row-form>button{min-height:38px}
.pn-root .pn-check{flex-direction:row;align-items:center;gap:8px;font-weight:400}
.pn-check input{accent-color:var(--dsw-alias-state-business-primary,#347864);width:16px;height:16px}
.pn-muted{color:var(--pn-muted)}
.pn-alert,.pn-notice{padding:10px 14px;margin:8px 0 16px;border:1px solid var(--pn-border);border-left:3px solid var(--dsw-alias-state-warn-label,#936400);border-radius:4px;overflow-wrap:anywhere}
.pn-alert{border-left-color:var(--dsw-alias-state-error-primary,#b22f2f)}
.pn-alert button{margin-left:12px}
.pn-root .pn-primary{background:var(--dsw-alias-button-primary-fill,#347864);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}
.pn-root .pn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#2d6856)}
.pn-root .pn-danger,.pn-task-error{color:var(--dsw-alias-state-error-primary,#b22f2f)}
.pn-footer{padding:24px 0 8px;font-size:12px;color:var(--pn-muted);border-top:1px solid var(--pn-border);margin-top:24px}
.pn-notebooks{display:grid;grid-template-columns:minmax(180px,25%) minmax(0,1fr);min-height:480px;border:1px solid var(--pn-border);border-radius:6px;overflow:hidden}
.pn-explorer{padding:14px 12px;border-right:1px solid var(--pn-border);min-width:0}
.pn-explorer-head,.pn-heading-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.pn-explorer-head h2{margin:0}
.pn-root .pn-pinned{display:block;text-align:left;width:100%;margin:14px 0;overflow-wrap:anywhere}
.pn-search{display:flex;gap:4px}
.pn-search input{width:100%}
.pn-breadcrumb{font-size:12px;display:flex;flex-wrap:wrap;margin:12px 0;gap:2px}
.pn-breadcrumb button{padding:1px 3px;border:0}
.pn-inline-form{display:flex;flex-direction:column;gap:8px;padding:12px 0}
.pn-inline-form button{align-self:start}
.pn-tree{display:flex;flex-direction:column;gap:2px}
.pn-tree>button{text-align:left;border:0;border-radius:3px;padding:7px 8px;overflow-wrap:anywhere;display:block}
.pn-tree>button[aria-current=page]{font-weight:600;background:var(--dsw-alias-interactive-bg-active,#e7efeb)}
.pn-tree small{display:block;color:var(--pn-muted);font-weight:400;font-size:12px}
.pn-note-panel{padding:20px;min-width:0}
.pn-empty{padding:32px 12px;color:var(--pn-muted)}
.pn-empty button{margin-right:8px;margin-top:8px}
.pn-note-toolbar{display:flex;justify-content:space-between;align-items:start;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--pn-border);padding-bottom:14px;margin-bottom:20px}
.pn-note-toolbar h2{font-size:14px;margin:0;overflow-wrap:anywhere}
.pn-actions{display:flex;flex-wrap:wrap;gap:6px}
.pn-note-toolbar button{font-size:12px;padding:3px 7px}
.pn-note-editor{width:100%;min-height:380px;font-family:ui-monospace,Consolas,monospace!important;font-size:13px!important}
.pn-save-row{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;flex-wrap:wrap}
.pn-save-row span{font-size:12px}
.pn-markdown{overflow-wrap:anywhere}
.pn-markdown p{white-space:pre-wrap;margin:0}
.pn-markdown h2,.pn-markdown h3,.pn-markdown h4{margin-top:16px}
.pn-markdown h2:first-child{margin-top:0}
.pn-markdown code{background:var(--dsw-alias-interactive-bg-hover,#f4f4f4);padding:1px 3px;border-radius:3px}
.pn-markdown blockquote{border-left:3px solid var(--pn-border);margin:8px 0;padding-left:12px;color:var(--pn-muted)}
.pn-paragraph-gap{height:12px}
.pn-list-line{padding-left:12px}
.pn-root .pn-text-link{padding:0;border:0;text-align:left;text-decoration:underline;color:var(--dsw-alias-state-business-primary,#347864)}
.pn-version-layout{display:grid;grid-template-columns:180px minmax(0,1fr);gap:16px;margin-bottom:16px}
.pn-version-list{display:flex;flex-direction:column;gap:4px}
.pn-version-list button{text-align:left;font-size:12px}
.pn-version-list small{display:block;color:var(--pn-muted)}
.pn-version-diff>div{margin-bottom:14px}
.pn-version-diff pre{max-height:320px;overflow:auto}
.pn-task-list{display:flex;flex-direction:column;margin-top:16px}
.pn-task{padding:18px 0;border-top:1px solid var(--pn-border)}
.pn-task h3{margin-bottom:0}
.pn-task .pn-muted{font-size:12px;margin:6px 0 10px}
.pn-status{font-size:12px;padding:2px 8px;border:1px solid var(--pn-border);border-radius:4px}
.pn-status-running{color:var(--dsw-alias-state-business-primary,#347864)}
.pn-status-failed{color:var(--dsw-alias-state-error-primary,#b22f2f)}
.pn-progress{display:flex;flex-wrap:wrap;gap:12px 24px;margin:8px 0 14px}
.pn-progress>div{display:flex;gap:6px;font-size:12px;overflow-wrap:anywhere;max-width:100%}
.pn-progress dt{color:var(--pn-muted)}
.pn-progress dd{margin:0}
.pn-trajectory{margin-top:16px}
.pn-trajectory details{padding:6px 0}
.pn-import-preview{padding-top:24px}
.pn-import-preview ul{max-height:220px;overflow:auto}
.pn-visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.pn-session-selector{position:relative;display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;max-width:100%;font:12px/1.5 system-ui,sans-serif;color:var(--dsw-alias-label-primary,#222)}
.pn-session-selector label{display:flex;align-items:center;gap:4px;min-width:0}
.pn-session-selector select,.pn-session-selector input,.pn-session-selector button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l3,#ddd);border-radius:var(--dsw-radius-sm,5px);padding:4px 6px;background:var(--dsw-alias-bg-layer-1,#fff);max-width:160px;min-width:0}
.pn-session-selector input{width:160px}
.pn-session-selector button,.pn-session-selector summary{cursor:pointer}
.pn-session-selector button:disabled,.pn-session-selector select:disabled,.pn-session-selector input:disabled{opacity:.5;cursor:default}
.pn-session-selector :focus-visible{outline:2px solid var(--dsw-focus-ring-color,#21896e);outline-offset:2px}
.pn-session-current{overflow-wrap:anywhere}
.pn-session-selector details{position:relative}
.pn-session-selector summary{padding:4px 6px;white-space:nowrap}
.pn-session-popup{position:absolute;bottom:calc(100% + 8px);left:0;z-index:30;width:min(340px,calc(100vw - 32px));max-height:70vh;overflow:auto;display:flex;flex-direction:column;align-items:stretch;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l3,#ddd);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 2px 8px #0002}
.pn-session-popup p{margin:0;overflow-wrap:anywhere}
.pn-session-popup label{justify-content:space-between}
.pn-session-popup select,.pn-session-popup input{flex:1;max-width:220px}
.pn-session-popup button{max-width:none;align-self:start}
.pn-session-error>summary{color:var(--dsw-alias-state-error-primary,#b22f2f)}
.pn-session-notice{color:var(--dsw-alias-label-secondary,#666)}
@media(max-width:480px){.pn-session-selector{gap:4px}.pn-session-selector label{max-width:100%}.pn-session-selector select{max-width:120px}.pn-session-popup{left:auto;right:0}}
@media(max-width:760px){.pn-page-header{flex-direction:column;gap:12px}.pn-role-picker{width:100%}.pn-notebooks{grid-template-columns:1fr}.pn-explorer{border-right:0;border-bottom:1px solid var(--pn-border)}.pn-tree{max-height:220px;overflow:auto}.pn-note-panel{padding:16px}.pn-version-layout{grid-template-columns:1fr}.pn-tabs button{padding:8px}.pn-root h1{font-size:20px}}
`;
