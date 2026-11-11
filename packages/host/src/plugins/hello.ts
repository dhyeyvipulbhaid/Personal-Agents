const HELLO_DOCUMENT = `<!doctype html>
<html lang="en" data-theme="__PA_THEME__">
  <head>
    <meta charset="utf-8" />
    <title>Hello</title>
    <style>
      html[data-theme="light"] { background: #f4f1ea; color: #1c1915; }
      html[data-theme="dark"] { background: #1c1915; color: #f4f1ea; }
      body { font-family: "Segoe UI", sans-serif; margin: 16px; }
      p { margin: 0; font-size: 18px; }
    </style>
  </head>
  <body>
    <p id="greeting">Hello</p>
  </body>
</html>`;

/** Built-in plugin. The page replaces __PA_THEME__ inside the sandboxed frame. */
export const HELLO_PLUGIN_SOURCE = `
export const manifest = {
  id: "hello",
  name: "Hello",
  version: "0.0.0",
  minCoreVersion: "0.0.0",
  tile: { title: "Hello" },
  effects: ["tile"]
};
export function apply(ctx) {
  ctx.register({
    effect: "tile",
    id: "hello",
    title: "Hello",
    html: ${JSON.stringify(HELLO_DOCUMENT)}
  });
}
`;
