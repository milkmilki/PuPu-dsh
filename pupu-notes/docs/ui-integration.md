# Native DSH client integration

The package targets the installed official SDK `0.2.1-rc.2`. The browser entry is
`src/ui/index.tsx`, mounted into the canonical `settings.section` list as
`pupu-notes`. The shell supplies its `close` callback. The plugin injects its own
Remote API and the official `uiWorkspace.openSession` navigation callback.

The browser artifact must be a lazy CommonJS factory:

```js
window.__ModuleLoader__.load({
  id: 'dsh-pupu-notes',
  factory: require => {
    var module = { exports: {} };
    var exports = module.exports;
    // Bundled CommonJS entry, with platform modules resolved by require.
    return module.exports;
  },
});
```

React, `react/jsx-runtime`, and Cordis are shared platform externals. The pure
`@deepseek-ai/dsh-typert-protocol/remote-info` helper and Zod belong inside the
bundle; the official client build explicitly allows this protocol layer to be
inlined. DSH service imports used to obtain type declarations are `import type`
and emit no runtime dependencies.

Client metadata must declare `platform: "web"` and load these client packages:

- `@deepseek-ai/dsh-api-remotes`
- `@deepseek-ai/dsh-client-ui-settings`
- `@deepseek-ai/dsh-client-ui-renderer`
- `@deepseek-ai/dsh-client-ui-workspace`

`src/remote.ts` is the single typed Host/UI boundary. The browser explicitly
mounts its `TYPERT_REMOTE`, and the Host registers the same method descriptor
with the Typert registry. No ad hoc browser HTTP endpoint is introduced.

The UI reads complete paginated files before opening its whole-file editor and
submits exact original text with its revision. Markdown is rendered from React
text nodes; raw HTML is never inserted. Notebook links permit scoped relative
Markdown paths and HTTP(S) links, while script, disk, and escaping paths are
noninteractive. Hidden internal role/task/version keys are carried in requests,
not presented as note labels.

Official implementation references used:

- `packages/client/ui-settings/src/client/contract/slots.ts`
- `packages/client/ui-settings-models/src/client/index.ts`
- `packages/client/ui-workspace/src/client/navigation.ts`
- `packages/client/tsdown.client.ts`
- `packages/client/web/src/platform.ts`
- installed `@deepseek-ai/dsh-typert-protocol/lib/types/remote-info.d.ts`

These files were inspected in the local official DSH checkout and installed
`0.2.1-rc.2` SDK. Existing PuPu plugin source was not used.
