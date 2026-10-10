import { checkNativeInteractions, withBrowser } from "./browser.mjs";

// CSS radio state and real anchors must work without the enhancement script.
await withBrowser((page) => checkNativeInteractions(page, false), {
  javaScriptEnabled: false,
});
